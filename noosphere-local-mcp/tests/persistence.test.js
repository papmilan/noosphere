import assert from 'node:assert/strict';
import { stat, writeFile } from 'node:fs/promises';
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
});
