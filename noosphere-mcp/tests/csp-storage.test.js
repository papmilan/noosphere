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
    const outside = await tempRoot();
    const directoryRoot = await tempRoot();
    try {
      await symlink(outside, path.join(directoryRoot, '.noosphere'));
    } catch (error) {
      if (process.platform === 'win32' && ['EACCES', 'EPERM'].includes(error.code)) {
        t.skip('symbolic-link coverage requires Windows privileges');
        return;
      }
      throw error;
    }
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

  it('returns structured errors for null, empty, and malformed legacy state', async () => {
    const cases = [
      { bytes: 'null\n', code: 'state-file-ambiguous' },
      { bytes: '{}\n', code: 'state-file-ambiguous' },
      { bytes: '{bad json\n', code: 'csp-json-invalid' },
    ];

    for (const fixture of cases) {
      const root = await tempRoot();
      const { dir, state, runtime } = cspPaths(root);
      await mkdir(dir);
      await writeFile(state, fixture.bytes);

      await assert.rejects(
        migrateLegacyRuntimeState(root),
        (error) => !(error instanceof TypeError) && error.code === fixture.code,
      );
      assert.equal(await readFile(state, 'utf8'), fixture.bytes);
      await assert.rejects(readFile(runtime), (error) => error.code === 'ENOENT');
    }
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

  it('retries a Windows permission answer instead of failing the lock', async () => {
    const root = await tempRoot();
    await mkdir(cspPaths(root).dir);
    let attempts = 0;
    const value = await withCspLock(root, async () => 'committed', {
      platform: 'win32',
      openImpl: async (...args) => {
        attempts += 1;
        // Windows reports a lock another handle still holds — or one pending
        // delete — as EPERM where POSIX reports EEXIST.
        if (attempts === 1) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
        return open(...args);
      },
    });
    assert.equal(value, 'committed');
    assert.equal(attempts, 2);
  });

  it('still refuses a permission error that never clears', async () => {
    const root = await tempRoot();
    await mkdir(cspPaths(root).dir);
    // Retrying must not turn a genuine ACL problem into a generic timeout.
    await assert.rejects(
      withCspLock(root, async () => 'unreachable', {
        platform: 'win32',
        openImpl: async () => {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        },
      }),
      (error) => error.code === 'EACCES',
    );
  });

  it('does not retry a permission error off Windows', async () => {
    const root = await tempRoot();
    await mkdir(cspPaths(root).dir);
    let attempts = 0;
    await assert.rejects(
      withCspLock(root, async () => 'unreachable', {
        platform: 'linux',
        openImpl: async () => {
          attempts += 1;
          throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
        },
      }),
      (error) => error.code === 'EPERM',
    );
    assert.equal(attempts, 1);
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

  it('splits CSP state that a pre-2.4 writer contaminated with telemetry', async () => {
    const root = await tempRoot();
    const { dir, state, runtime } = cspPaths(root);
    await mkdir(dir);
    const telemetry = {
      pending_checkpoint_fingerprint: 'abc',
      last_checkpoint_at: '2026-07-30T14:00:00.000Z',
      last_blob_id: null,
      last_checkpoint_pending: true,
      last_workspace_fingerprint: 'def',
    };
    await writeFile(
      state,
      `${JSON.stringify({ ...validState(), ...telemetry })}\n`,
    );

    assert.deepEqual(await migrateLegacyRuntimeState(root), {
      migrated: true,
      reason: 'legacy-telemetry-split',
    });
    assert.deepEqual(await loadState(root), validState());
    assert.deepEqual(JSON.parse(await readFile(runtime, 'utf8')), telemetry);

    // Re-entering must be a no-op rather than a second migration.
    assert.deepEqual(await migrateLegacyRuntimeState(root), {
      migrated: false,
      reason: 'csp-state-present',
    });
  });

  it('reports the offending fields instead of splitting an unrecognized state', async () => {
    const root = await tempRoot();
    const { dir, state } = cspPaths(root);
    await mkdir(dir);
    // A hand-written status typo is not telemetry contamination. It must be
    // named, never silently rewritten.
    const contents = `${JSON.stringify({
      ...validState(),
      status: 'in_progress',
      last_blob_id: null,
    })}\n`;
    await writeFile(state, contents);

    await assert.rejects(migrateLegacyRuntimeState(root), (error) => {
      assert.equal(error.code, 'csp-schema-invalid');
      assert.ok(
        error.errors.some((issue) => issue.path === '$.status'),
        'expected the invalid status to be reported',
      );
      return true;
    });
    assert.equal(await readFile(state, 'utf8'), contents);
  });

  it('migrates legacy telemetry on a filesystem without hard links', async () => {
    const root = await tempRoot();
    const { dir, state, runtime } = cspPaths(root);
    await mkdir(dir);
    const legacy = { last_checkpoint_at: '2026-07-30T10:00:00.000Z', last_blob_id: null };
    await writeFile(state, `${JSON.stringify(legacy)}\n`);

    // exFAT, FAT32 and most SMB mounts answer link() with ENOTSUP.
    assert.deepEqual(
      await migrateLegacyRuntimeState(root, {
        linkImpl: async () => {
          throw Object.assign(new Error('operation not supported'), {
            code: 'ENOTSUP',
          });
        },
      }),
      { migrated: true, reason: 'legacy-state-moved' },
    );
    assert.deepEqual(JSON.parse(await readFile(runtime, 'utf8')), legacy);
    await assert.rejects(readFile(state), (error) => error.code === 'ENOENT');
  });

  it('refuses to clobber an existing destination when links are unavailable', async () => {
    const root = await tempRoot();
    const { dir, state, runtime } = cspPaths(root);
    await mkdir(dir);
    await writeFile(state, `${JSON.stringify({ last_blob_id: 'AAA' })}\n`);
    const occupied = `${JSON.stringify({ last_blob_id: 'BBB' })}\n`;
    await writeFile(runtime, occupied);

    await assert.rejects(
      migrateLegacyRuntimeState(root, {
        linkImpl: async () => {
          throw Object.assign(new Error('operation not supported'), {
            code: 'ENOTSUP',
          });
        },
      }),
      /refusing to discard either file/,
    );
    assert.equal(await readFile(runtime, 'utf8'), occupied);
  });
});
