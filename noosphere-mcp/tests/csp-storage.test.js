import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  cspPaths,
  loadState,
  loadStateRecord,
  migrateLegacyRuntimeState,
  withCspLock,
  writeStateAtomic,
} from '../continuity/csp/storage.js';

const roots = [];

async function tempRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'noosphere-csp-storage-'));
  roots.push(root);
  return root;
}

function validState() {
  return {
    version: 1,
    status: 'in-progress',
    current_task: 'Implement CSP',
    next_action: 'Run tests',
    blocker: null,
  };
}

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('CSP storage and runtime-state migration', () => {
  it('returns null when canonical state is missing', async () => {
    assert.equal(await loadState(await tempRoot()), null);
  });

  it('loads validated state with an exact source-byte identity', async () => {
    const root = await tempRoot();
    const { dir, state } = cspPaths(root);
    await mkdir(dir);
    const bytes = Buffer.from(`${JSON.stringify(validState(), null, 2)}\n`);
    await writeFile(state, bytes);
    const loaded = await loadState(root);
    const record = await loadStateRecord(root);
    assert.deepEqual(loaded, validState());
    assert.equal(record.identity, createHash('sha256').update(bytes).digest('hex'));
  });

  it('rejects corrupt JSON and schema violations without rewriting bytes', async () => {
    const root = await tempRoot();
    const { dir, state } = cspPaths(root);
    await mkdir(dir);
    await writeFile(state, '{bad json\n');
    await assert.rejects(loadState(root), (error) => error.code === 'csp-json-invalid');
    assert.equal(await readFile(state, 'utf8'), '{bad json\n');

    const invalid = `${JSON.stringify({ ...validState(), revision: 1 })}\n`;
    await writeFile(state, invalid);
    await assert.rejects(loadState(root), (error) => (
      error.code === 'csp-schema-invalid'
      && error.errors.some((entry) => entry.path === '$.revision')
    ));
    assert.equal(await readFile(state, 'utf8'), invalid);
  });

  it('rejects malformed UTF-8 before JSON parsing', async () => {
    const root = await tempRoot();
    const { dir, state } = cspPaths(root);
    await mkdir(dir);
    const invalid = Buffer.from([0xc3, 0x28]);
    await writeFile(state, invalid);
    await assert.rejects(loadState(root), (error) => error.code === 'csp-utf8-invalid');
    assert.deepEqual(await readFile(state), invalid);
  });

  it('refuses symlinked state directories and final files', async (t) => {
    if (process.platform === 'win32') t.skip('symbolic-link coverage requires Windows privileges');
    const outside = await tempRoot();
    const directoryRoot = await tempRoot();
    await symlink(outside, path.join(directoryRoot, '.noosphere'));
    await assert.rejects(loadState(directoryRoot), (error) => error.code === 'state-dir-symlink');

    const fileRoot = await tempRoot();
    const { dir, state } = cspPaths(fileRoot);
    await mkdir(dir);
    const sentinel = path.join(outside, 'sentinel.json');
    await writeFile(sentinel, `${JSON.stringify(validState())}\n`);
    await symlink(sentinel, state);
    await assert.rejects(loadState(fileRoot), (error) => (
      error.code === 'state-file-symlink' || error.code === 'ELOOP'
    ));
  });

  it('atomically migrates recognized legacy telemetry without changing bytes', async () => {
    const root = await tempRoot();
    const { dir, state, runtime } = cspPaths(root);
    await mkdir(dir);
    const legacy = Buffer.from(`${JSON.stringify({
      baseline: { status: 'stored', fingerprint: 'abc' },
      last_checkpoint_at: '2026-07-18T00:00:00.000Z',
      last_blob_id: 'blob-1',
    }, null, 2)}\n`);
    await writeFile(state, legacy);
    const result = await migrateLegacyRuntimeState(root);
    assert.deepEqual(result, { migrated: true, reason: 'legacy-state-moved' });
    assert.deepEqual(await readFile(runtime), legacy);
    await assert.rejects(readFile(state), (error) => error.code === 'ENOENT');
  });

  it('removes only an identical legacy duplicate when runtime state already exists', async () => {
    const root = await tempRoot();
    const { dir, state, runtime } = cspPaths(root);
    await mkdir(dir);
    const legacy = Buffer.from(`${JSON.stringify({ last_workspace_fingerprint: 'abc' })}\n`);
    await writeFile(state, legacy);
    await writeFile(runtime, legacy);
    const result = await migrateLegacyRuntimeState(root);
    assert.deepEqual(result, { migrated: true, reason: 'identical-runtime-retained' });
    assert.deepEqual(await readFile(runtime), legacy);
    await assert.rejects(readFile(state), (error) => error.code === 'ENOENT');
  });

  it('fails closed when runtime and legacy telemetry differ', async () => {
    const root = await tempRoot();
    const { dir, state, runtime } = cspPaths(root);
    await mkdir(dir);
    const legacy = Buffer.from(`${JSON.stringify({ last_blob_id: 'legacy' })}\n`);
    const existing = Buffer.from(`${JSON.stringify({ last_blob_id: 'current' })}\n`);
    await writeFile(state, legacy);
    await writeFile(runtime, existing);
    await assert.rejects(
      migrateLegacyRuntimeState(root),
      (error) => error.code === 'runtime-state-migration-conflict',
    );
    assert.deepEqual(await readFile(state), legacy);
    assert.deepEqual(await readFile(runtime), existing);
  });

  it('fails closed on ambiguous state instead of treating it as telemetry', async () => {
    const root = await tempRoot();
    const { dir, state } = cspPaths(root);
    await mkdir(dir);
    const ambiguous = Buffer.from('{"current_task":"maybe-csp"}\n');
    await writeFile(state, ambiguous);
    await assert.rejects(
      migrateLegacyRuntimeState(root),
      (error) => error.code === 'state-file-ambiguous',
    );
    assert.deepEqual(await readFile(state), ambiguous);
    assert.equal((await lstat(state)).isFile(), true);
  });

  it('treats an empty object as ambiguous rather than positive legacy telemetry', async () => {
    const root = await tempRoot();
    const { dir, state, runtime } = cspPaths(root);
    await mkdir(dir);
    await writeFile(state, '{}\n');

    await assert.rejects(
      migrateLegacyRuntimeState(root),
      (error) => error.code === 'state-file-ambiguous',
    );
    assert.equal(await readFile(state, 'utf8'), '{}\n');
    await assert.rejects(readFile(runtime), (error) => error.code === 'ENOENT');
  });

  it('does not overwrite a runtime destination created during migration', async () => {
    const root = await tempRoot();
    const { dir, state, runtime } = cspPaths(root);
    await mkdir(dir);
    const legacy = Buffer.from('{"last_blob_id":"legacy"}\n');
    const concurrent = Buffer.from('{"last_blob_id":"concurrent"}\n');
    await writeFile(state, legacy);

    await assert.rejects(
      migrateLegacyRuntimeState(root, {
        beforeMove: async () => writeFile(runtime, concurrent),
      }),
      (error) => error.code === 'runtime-state-migration-conflict',
    );
    assert.deepEqual(await readFile(state), legacy);
    assert.deepEqual(await readFile(runtime), concurrent);
  });

  it('does not remove a legacy source replaced after duplicate comparison', async () => {
    const root = await tempRoot();
    const { dir, state, runtime } = cspPaths(root);
    await mkdir(dir);
    const legacy = Buffer.from('{"last_blob_id":"same"}\n');
    const replacement = Buffer.from('{"last_blob_id":"replacement"}\n');
    await writeFile(state, legacy);
    await writeFile(runtime, legacy);

    await assert.rejects(
      migrateLegacyRuntimeState(root, {
        beforeRemoveDuplicate: async () => writeFile(state, replacement),
      }),
      (error) => error.code === 'runtime-state-migration-conflict',
    );
    assert.deepEqual(await readFile(state), replacement);
    assert.deepEqual(await readFile(runtime), legacy);
  });

  it('rechecks canonical identity after the final pre-replace hook', async () => {
    const root = await tempRoot();
    const { dir, state } = cspPaths(root);
    await mkdir(dir);
    const base = Buffer.from(`${JSON.stringify(validState(), null, 2)}\n`);
    const externalState = { ...validState(), next_action: 'External edit' };
    const external = Buffer.from(`${JSON.stringify(externalState, null, 2)}\n`);
    await writeFile(state, base);
    const record = await loadStateRecord(root);

    await assert.rejects(
      writeStateAtomic(
        root,
        { ...validState(), next_action: 'Proposed edit' },
        record.identity,
        { afterIdentityCheck: async () => writeFile(state, external) },
      ),
      (error) => error.code === 'csp-write-stale',
    );
    assert.deepEqual(await readFile(state), external);
    assert.equal((await readdir(dir)).some((name) => name.endsWith('.tmp')), false);
  });

  it('cleans the temporary file when atomic replacement fails', async () => {
    const root = await tempRoot();
    const { dir, state } = cspPaths(root);
    await mkdir(dir);
    const base = Buffer.from(`${JSON.stringify(validState(), null, 2)}\n`);
    await writeFile(state, base);
    const record = await loadStateRecord(root);

    await assert.rejects(
      writeStateAtomic(root, { ...validState(), next_action: 'Proposed edit' }, record.identity, {
        beforeReplace: async () => { throw Object.assign(new Error('injected replace failure'), { code: 'EIO' }); },
      }),
      (error) => error.code === 'EIO',
    );
    assert.deepEqual(await readFile(state), base);
    assert.equal((await readdir(dir)).some((name) => name.endsWith('.tmp')), false);
  });

  it('removes an owned lock when lock initialization fails', async () => {
    const root = await tempRoot();
    const { lock } = cspPaths(root);
    await assert.rejects(
      withCspLock(root, async () => undefined, {
        openImpl: async (...args) => {
          const handle = await open(...args);
          return {
            writeFile: (...writeArgs) => handle.writeFile(...writeArgs),
            sync: async () => { throw Object.assign(new Error('injected sync failure'), { code: 'EIO' }); },
            close: () => handle.close(),
          };
        },
      }),
      (error) => error.code === 'EIO',
    );
    await assert.rejects(readFile(lock), (error) => error.code === 'ENOENT');
  });

  it('leaves valid CSP state untouched', async () => {
    const root = await tempRoot();
    const { dir, state, runtime } = cspPaths(root);
    await mkdir(dir);
    const bytes = Buffer.from(`${JSON.stringify(validState())}\n`);
    await writeFile(state, bytes);
    assert.deepEqual(
      await migrateLegacyRuntimeState(root),
      { migrated: false, reason: 'csp-state-present' },
    );
    assert.deepEqual(await readFile(state), bytes);
    await assert.rejects(readFile(runtime), (error) => error.code === 'ENOENT');
  });
});
