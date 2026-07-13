import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import {
  readExecutionState,
  writeExecutionState,
  executionPaths,
} from '../continuity/acp/execution-store.js';
import { EXECUTION_PROTOCOL } from '../continuity/acp/execution-state.js';
import { workspaceFingerprintHex } from '../continuity/acp/git-state.js';

const execFileAsync = promisify(execFile);
const CREATED_AT = '2026-07-13T09:00:00.000Z';
const EXPIRES_AT = '2026-07-16T09:00:00.000Z';
const dirs = [];

async function makeRepo() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'noosphere-exec-store-'));
  dirs.push(dir);
  await execFileAsync('git', ['init'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 't@example.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await writeFile(path.join(dir, 'README.md'), '# test\n');
  await writeFile(path.join(dir, '.gitignore'), '.noosphere/\n');
  await execFileAsync('git', ['add', '.'], { cwd: dir });
  await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: dir });
  return dir;
}

function envelope() {
  return {
    protocol: EXECUTION_PROTOCOL,
    project_snapshot_id: `sha256:${'a'.repeat(64)}`,
    created_at: CREATED_AT,
    expires_at: EXPIRES_AT,
    origin: { agent_id: 'claude', client: 'claude-code', session_id: null },
    repository: {
      project_id: 'noosphere',
      head: 'b'.repeat(40),
      branch: 'main',
      dirty: false,
      workspace_fingerprint: `sha256:${'c'.repeat(64)}`,
    },
    cursor: {
      step_id: 's1',
      status: 'before-edit',
      opened_files: [],
      target: { file: 'a.js', symbol: null, purpose: 'Do the thing.' },
    },
    steps: [
      {
        id: 's1', parent_step_id: null, kind: 'edit', status: 'current',
        target: { file: 'a.js', symbol: null, content_hash: null },
        goal: 'Do the thing.', verify: { command: 'node --test t', expectation: 'pass' },
      },
    ],
    frontier: { searched: [], ruled_out: [] },
    validation: { last_command: null, last_result: null, failing_tests: [] },
    working_notes: [],
    integrity: {
      algorithm: 'sha256',
      digest: '0'.repeat(64),
      signature: { status: 'unsigned', algorithm: null, key_id: null, value: null },
    },
  };
}

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('ACP execution store', () => {
  let repo;

  before(async () => {
    repo = await makeRepo();
  });

  it('writes canonical JSON plus the advisory kernel atomically with owner-only permissions', async () => {
    const written = await writeExecutionState(repo, envelope(), { now: '2026-07-13T10:00:00.000Z' });
    const { json, markdown } = executionPaths(repo);
    const storedJson = JSON.parse(await readFile(json, 'utf8'));
    const kernel = await readFile(markdown, 'utf8');
    assert.equal(storedJson.integrity.digest, written.envelope.integrity.digest);
    assert.match(kernel, /# EXECUTION CHECKPOINT \(advisory/);
    assert.equal((await stat(json)).mode & 0o777, 0o600);
    assert.equal((await stat(markdown)).mode & 0o777, 0o600);
  });

  it('reads back a valid state and returns null when absent', async () => {
    const fresh = await makeRepo();
    assert.equal(await readExecutionState(fresh), null);
    await writeExecutionState(fresh, envelope(), { now: '2026-07-13T10:00:00.000Z' });
    const read = await readExecutionState(fresh);
    assert.equal(read.ok, true);
    assert.equal(read.state.envelope.cursor.step_id, 's1');
  });

  it('detects tampering through the content digest', async () => {
    const fresh = await makeRepo();
    await writeExecutionState(fresh, envelope(), { now: '2026-07-13T10:00:00.000Z' });
    const { json } = executionPaths(fresh);
    const stored = JSON.parse(await readFile(json, 'utf8'));
    stored.cursor.target.purpose = 'Do something else.';
    await writeFile(json, JSON.stringify(stored, null, 2));
    const read = await readExecutionState(fresh);
    assert.equal(read.ok, false);
    assert.ok(read.errors.some(({ code }) => code === 'digest-mismatch'));
  });

  it('reports corrupt JSON without overwriting it', async () => {
    const fresh = await makeRepo();
    await writeExecutionState(fresh, envelope(), { now: '2026-07-13T10:00:00.000Z' });
    const { json } = executionPaths(fresh);
    await writeFile(json, '{ not valid');
    const read = await readExecutionState(fresh);
    assert.equal(read.ok, false);
    assert.equal(await readFile(json, 'utf8'), '{ not valid');
  });

  it('leaves previous files intact and cleans temp files when a write fails', async () => {
    const fresh = await makeRepo();
    await writeExecutionState(fresh, envelope(), { now: '2026-07-13T10:00:00.000Z' });
    const { json, dir } = executionPaths(fresh);
    const before = await readFile(json, 'utf8');
    await assert.rejects(
      writeExecutionState(fresh, envelope(), {
        now: '2026-07-13T11:00:00.000Z',
        rename: async () => {
          throw new Error('injected rename failure');
        },
      }),
      /injected rename failure/,
    );
    assert.equal(await readFile(json, 'utf8'), before);
    const leftovers = (await import('node:fs/promises')).readdir(dir);
    assert.ok(!(await leftovers).some((name) => name.includes('.tmp')));
  });

  it('rejects an invalid envelope before touching disk', async () => {
    const fresh = await makeRepo();
    const bad = envelope();
    bad.expires_at = null;
    await assert.rejects(writeExecutionState(fresh, bad, { now: '2026-07-13T10:00:00.000Z' }), /missing-expiry/);
    assert.equal(await readExecutionState(fresh), null);
  });

  it('does not change the workspace fingerprint when a checkpoint is written', async () => {
    const fresh = await makeRepo();
    const before = await workspaceFingerprintHex(fresh);
    await writeExecutionState(fresh, envelope(), { now: '2026-07-13T10:00:00.000Z' });
    assert.equal(await workspaceFingerprintHex(fresh), before);
  });
});
