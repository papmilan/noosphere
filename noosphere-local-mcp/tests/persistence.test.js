import assert from 'node:assert/strict';
import { access, mkdir, readFile, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { validCheckpoint, validProject } from '@noosphere/remote-mcp-contracts/tests/fixtures.js';

import { FileProjectMemoryRepository } from '../src/file-repository.js';
import { localOwnerScope } from '../src/local-identity.js';
import { startStdioClient, structured, temporaryStateFile as stateFile } from './harness.js';

describe('Local STDIO durable store', () => {
  it('remembers a project and its checkpoint across a full server restart', async () => {
    const file = await stateFile();

    // First host session: create a project, a session, and a checkpoint, then
    // shut the server down exactly as an MCP host would.
    const first = await startStdioClient({ stateFile: file });
    let projectId;
    let sessionId;
    try {
      const project = structured(await first.client.callTool({ name: 'create_project', arguments: { name: 'Bicycle Repair' } })).project;
      projectId = project.id;
      sessionId = structured(await first.client.callTool({ name: 'create_session', arguments: { project_id: projectId, source_client: 'first-host' } })).session.id;
      const checkpoint = validCheckpoint({ id: 'chk_persist1', project_id: projectId, session_id: sessionId, revision: 1, previous_checkpoint_id: null, current_status: 'Rotor measured.' });
      await first.client.callTool({ name: 'save_checkpoint', arguments: { project_id: projectId, session_id: sessionId, checkpoint, idempotency_key: 'persist-1' } });
    } finally {
      await first.close();
    }

    // A brand new process against the same store — nothing is shared but the file.
    const second = await startStdioClient({ stateFile: file });
    try {
      const resumed = structured(await second.client.callTool({ name: 'resume_project', arguments: { project_id: projectId } }));
      assert.equal(resumed.project.id, projectId, 'the project survived the restart');
      assert.equal(resumed.project.name, 'Bicycle Repair');
      assert.equal(resumed.latest_checkpoint.id, 'chk_persist1', 'the checkpoint head survived the restart');
      assert.equal(resumed.latest_checkpoint.current_status, 'Rotor measured.', 'checkpoint content is intact, not just its id');

      // The idempotency receipt survived too: a replayed key deduplicates
      // instead of colliding with the stored checkpoint.
      const checkpoint = validCheckpoint({ id: 'chk_persist1', project_id: projectId, session_id: sessionId, revision: 1, previous_checkpoint_id: null, current_status: 'Rotor measured.' });
      const replay = structured(await second.client.callTool({ name: 'save_checkpoint', arguments: { project_id: projectId, session_id: sessionId, checkpoint, idempotency_key: 'persist-1' } }));
      assert.equal(replay.deduplicated, true, 'idempotency receipts are durable, so a retry after a restart is not a conflict');
    } finally {
      await second.close();
    }
  });

  it('writes the store owner-only through the secure-fs boundary', async () => {
    const file = await stateFile();
    const repository = await FileProjectMemoryRepository.open({ file });
    await repository.createProject({ ownerScope: localOwnerScope(), project: validProject() });

    const info = await stat(file);
    assert.equal(info.isFile(), true);
    // Mode bits are not meaningful on Windows, where the same boundary applies
    // an explicit owner-only ACL instead.
    if (process.platform !== 'win32') assert.equal(info.mode & 0o777, 0o600, 'store is readable only by its owner');
  });

  it('fails closed on a corrupt store instead of starting empty and overwriting it', async () => {
    const file = await stateFile();
    await writeFile(file, '{ this is not json', { mode: 0o600 });
    await assert.rejects(FileProjectMemoryRepository.open({ file }), SyntaxError);
  });

  it('rejects malformed UTF-8 even when lossy decoding would produce valid JSON', async () => {
    const file = await stateFile();
    const repository = await FileProjectMemoryRepository.open({ file });
    await repository.createProject({ ownerScope: localOwnerScope(), project: validProject({ name: 'Alpha Project' }) });
    const bytes = await readFile(file);
    const marker = Buffer.from('Alpha Project');
    const offset = bytes.indexOf(marker);
    assert.notEqual(offset, -1, 'fixture name must be present in the durable snapshot');
    const corrupt = Buffer.from(bytes);
    corrupt[offset] = 0xc3;
    corrupt[offset + 1] = 0x28;
    await writeFile(file, corrupt, { mode: 0o600 });

    await assert.rejects(
      FileProjectMemoryRepository.open({ file }),
      (error) => error.code === 'local-store-invalid-utf8',
    );
  });

  it('refuses a structurally valid store holding an invalid record', async () => {
    const file = await stateFile();
    const owner = localOwnerScope();
    // Well-formed JSON, but the project record violates the schema. Persisted
    // bytes are untrusted: this must be rejected on load, not on first use.
    await writeFile(file, JSON.stringify({ projects: { [owner]: { prj_bad: { id: 'prj_bad', name: 42 } } } }), { mode: 0o600 });
    await assert.rejects(FileProjectMemoryRepository.open({ file }));
  });

  it('starts empty on a first run when no store exists yet', async () => {
    const file = await stateFile();
    const repository = await FileProjectMemoryRepository.open({ file });
    assert.deepEqual(await repository.listProjects({ ownerScope: localOwnerScope() }), []);
  });

  it('does not lose writes when two local MCP hosts share one state file', async () => {
    const file = await stateFile();
    const first = await FileProjectMemoryRepository.open({ file });
    const second = await FileProjectMemoryRepository.open({ file });
    const ownerScope = localOwnerScope();

    await Promise.all([
      first.createProject({
        ownerScope,
        project: validProject({ id: 'prj_01alpha', name: 'Alpha Project', normalized_name: 'alpha project', aliases: [] }),
      }),
      second.createProject({
        ownerScope,
        project: validProject({ id: 'prj_01beta', name: 'Beta Project', normalized_name: 'beta project', aliases: [] }),
      }),
    ]);

    const reopened = await FileProjectMemoryRepository.open({ file });
    const ids = (await reopened.listProjects({ ownerScope })).map(({ id }) => id).sort();
    assert.deepEqual(ids, ['prj_01alpha', 'prj_01beta']);
  });

  it('recovers the mutation lock left by a killed local MCP host', async () => {
    const file = await stateFile();
    const lock = `${file}.lock`;
    await writeFile(lock, JSON.stringify({
      pid: 2_147_483_647,
      purpose: 'local-project-memory',
      token: '00000000-0000-4000-8000-000000000001',
    }), { mode: 0o600 });
    const repository = await FileProjectMemoryRepository.open({
      file,
      lockAttempts: 5,
      lockBackoffMs: 1,
    });

    await repository.createProject({ ownerScope: localOwnerScope(), project: validProject() });

    assert.equal((await repository.listProjects({ ownerScope: localOwnerScope() })).length, 1);
    await assert.rejects(access(lock));
  });

  it('recovers when the prior host died while reclaiming a mutation lock', async () => {
    const file = await stateFile();
    const lock = `${file}.lock`;
    const guard = `${lock}.reclaim`;
    await writeFile(lock, JSON.stringify({
      pid: 2_147_483_647,
      purpose: 'local-project-memory',
      token: '00000000-0000-4000-8000-000000000006',
    }), { mode: 0o600 });
    await mkdir(guard);
    await writeFile(
      `${guard}/owner-2147483647-00000000-0000-4000-8000-000000000007`,
      '',
      { mode: 0o600 },
    );
    const repository = await FileProjectMemoryRepository.open({
      file,
      lockAttempts: 5,
      lockBackoffMs: 0,
    });

    await repository.createProject({ ownerScope: localOwnerScope(), project: validProject() });

    assert.equal((await repository.listProjects({ ownerScope: localOwnerScope() })).length, 1);
    await assert.rejects(access(lock));
    await assert.rejects(access(guard));
  });

  it('never removes malformed mutation-lock metadata based on age', async () => {
    const file = await stateFile();
    const lock = `${file}.lock`;
    await writeFile(lock, '{malformed', { mode: 0o600 });
    await utimes(lock, new Date(0), new Date(0));
    const repository = await FileProjectMemoryRepository.open({
      file,
      lockAttempts: 2,
      lockBackoffMs: 0,
    });

    await assert.rejects(
      repository.createProject({ ownerScope: localOwnerScope(), project: validProject() }),
      (error) => error.code === 'trust-lock-busy',
    );
    assert.equal(await readFile(lock, 'utf8'), '{malformed');
    await assert.rejects(access(file));
  });

  it('rolls memory back when the durable write is refused', async (t) => {
    const file = await stateFile();
    const repository = await FileProjectMemoryRepository.open({ file });
    const outside = await stateFile();
    await writeFile(outside, 'outside\n', { mode: 0o600 });
    try {
      await symlink(outside, file);
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
        t.skip('creating a test symlink requires platform permission');
        return;
      }
      throw error;
    }

    await assert.rejects(
      repository.createProject({ ownerScope: localOwnerScope(), project: validProject() }),
      (error) => error.code === 'state-file-symlink',
    );
    assert.deepEqual(repository.snapshot().projects, {}, 'a failed durable commit must not remain visible in process memory');
  });
});
