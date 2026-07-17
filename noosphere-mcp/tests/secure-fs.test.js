import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { ensureContainedDir, ensureContainedDirSync, PathBoundaryError } from '../continuity/secure-fs.js';
import { buildInitialState, writeState } from '../continuity/acp/store.js';
import { writeExecutionState } from '../continuity/acp/execution-store.js';
import { EXECUTION_PROTOCOL } from '../continuity/acp/execution-state.js';

const dirs = [];
after(async () => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));
async function tempBase() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'noosphere-securefs-'));
  dirs.push(dir);
  return dir;
}
async function gitRepo(base) {
  const root = path.join(base, 'repo');
  await mkdir(root, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'x'], {
    cwd: root,
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
  return root;
}
const hasCode = (code) => (error) => error.code === code;
const CLOCK = '2026-07-12T00:00:00.000Z';

describe('secure-fs — containment helper', () => {
  it('creates a real state directory under root', async () => {
    const root = await tempBase();
    const dir = await ensureContainedDir(root, path.join(root, '.noosphere'));
    assert.equal(dir, path.join(root, '.noosphere'));
    const entries = await readdir(root);
    assert.ok(entries.includes('.noosphere'));
  });

  it('refuses a symlinked state directory', async () => {
    const base = await tempBase();
    const root = path.join(base, 'root');
    const outside = path.join(base, 'outside');
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(root, '.noosphere'));
    await assert.rejects(ensureContainedDir(root, path.join(root, '.noosphere')), hasCode('state-dir-symlink'));
  });

  it('refuses a symlinked intermediate component (nested)', async () => {
    const base = await tempBase();
    const root = path.join(base, 'root');
    const outside = path.join(base, 'outside');
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(root, '.noosphere'));
    await assert.rejects(ensureContainedDir(root, path.join(root, '.noosphere', 'execution')), hasCode('state-dir-symlink'));
  });

  it('rejects a directory outside root', async () => {
    const root = await tempBase();
    await assert.rejects(ensureContainedDir(root, path.join(root, '..', 'evil')), hasCode('state-dir-escape'));
  });

  it('sync variant refuses a symlinked directory', async () => {
    const base = await tempBase();
    const root = path.join(base, 'root');
    const outside = path.join(base, 'outside');
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(root, '.noosphere'));
    assert.throws(() => ensureContainedDirSync(root, path.join(root, '.noosphere')), hasCode('state-dir-symlink'));
  });
});

describe('secure-fs — SEC-03 exploit is blocked in the real stores', () => {
  it('writeState refuses to write through a symlinked .noosphere', async () => {
    const base = await tempBase();
    const root = await gitRepo(base);
    const outside = path.join(base, 'OUTSIDE');
    await mkdir(outside, { recursive: true });
    await rm(path.join(root, '.noosphere'), { recursive: true, force: true });
    await symlink(outside, path.join(root, '.noosphere'));

    const init = await buildInitialState(root, { clock: CLOCK });
    await assert.rejects(writeState(root, init.state, { clock: CLOCK }), (error) => error instanceof PathBoundaryError);
    assert.deepEqual(await readdir(outside), [], 'nothing may be written into the outside directory');
  });

  it('writeExecutionState refuses to write through a symlinked .noosphere', async () => {
    const base = await tempBase();
    const root = await gitRepo(base);
    const outside = path.join(base, 'OUTSIDE');
    await mkdir(outside, { recursive: true });
    await rm(path.join(root, '.noosphere'), { recursive: true, force: true });
    await symlink(outside, path.join(root, '.noosphere'));

    const envelope = minimalExecutionEnvelope();
    await assert.rejects(writeExecutionState(root, envelope, { now: CLOCK }), (error) => error instanceof PathBoundaryError);
    assert.deepEqual(await readdir(outside), [], 'nothing may be written into the outside directory');
  });
});

function minimalExecutionEnvelope() {
  return {
    protocol: EXECUTION_PROTOCOL,
    project_snapshot_id: `sha256:${'a'.repeat(64)}`,
    created_at: CLOCK,
    expires_at: '2026-07-19T00:00:00.000Z',
    origin: { agent_id: 'claude', client: 'claude-code', session_id: null },
    repository: {
      project_id: 'noosphere', head: 'b'.repeat(40), branch: 'main', dirty: false,
      workspace_fingerprint: `sha256:${'c'.repeat(64)}`,
    },
    cursor: { step_id: 's1', status: 'before-edit', opened_files: [], target: { file: 'a.js', symbol: null, purpose: 'Do the thing.' } },
    steps: [{
      id: 's1', parent_step_id: null, kind: 'edit', status: 'current',
      target: { file: 'a.js', symbol: null, content_hash: null },
      goal: 'Do the thing.', verify: { command: 'node --test t', expectation: 'pass' },
    }],
    frontier: { searched: [], ruled_out: [] },
    validation: { last_command: null, last_result: null, failing_tests: [] },
    working_notes: [],
    integrity: { algorithm: 'sha256', digest: '0'.repeat(64), signature: { status: 'unsigned', algorithm: null, key_id: null, value: null } },
  };
}
