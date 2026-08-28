// SEC-05 Phase 4B-R5 — the write that pairs with the bounded read.
//
// `fs.writeFile` truncates before it writes, so it publishes an empty file and
// then fills it. Noosphere reads the same repository files it rewrites, and
// `noosphere watch` means a concurrent reader is the normal state, so that
// window is reachable in ordinary use: a reader whose fstat lands inside it sees
// size 0 and returns zero bytes with NO error, which no caller can tell apart
// from a file the user emptied — and the read-modify-write callers then write
// that emptiness back.
//
// This suite pins the property that closes it: a reader concurrent with a writer
// observes the whole old file or the whole new one, never the gap.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  appendRepositoryFile,
  atomicRepositoryWrite,
  readBoundedRegularFile,
  removeRepositoryDirectoryIfEmpty,
  removeRepositoryFile,
  tryAcquireOwnerProcessGuard,
} from '../index.js';

const temporary = [];
after(async () => {
  for (const dir of temporary) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
});

async function fresh() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'noosphere-atomic-'));
  temporary.push(dir);
  return dir;
}

// One writer and one reader on the same path for a fixed wall-clock budget.
// Classifies every read: whole file, empty, partial, or refused.
async function race(file, body, write, { ms = 1200 } = {}) {
  const counts = { full: 0, empty: 0, partial: 0, refused: 0 };
  const stop = Date.now() + ms;
  const writer = (async () => {
    while (Date.now() < stop) await write(file, body);
  })();
  const reader = (async () => {
    while (Date.now() < stop) {
      // Yield a tick between reads. A reader that re-opens the file the instant
      // it closes it holds the target open almost continuously, which on Windows
      // starves the replace rather than exercising its atomicity — that would be
      // a starvation test wearing an atomicity test's name. This still performs
      // hundreds of reads inside the window.
      await new Promise((resolve) => setTimeout(resolve, 1));
      try {
        const bytes = await readBoundedRegularFile(file, { maxBytes: 4 * 1024 * 1024 });
        if (bytes === null || bytes.length === 0) counts.empty += 1;
        else if (bytes.length === Buffer.byteLength(body)) counts.full += 1;
        else counts.partial += 1;
      } catch {
        counts.refused += 1;
      }
    }
  })();
  await Promise.all([writer, reader]);
  return counts;
}

describe('SEC-05 Phase 4B-R5 — atomicRepositoryWrite has no window a reader can fall into', () => {
  // 200 KB: large enough that the truncate-then-write window is wide enough to
  // hit thousands of times per second, which is what made the defect measurable.
  const BODY = `${'x'.repeat(200_000)}\n`;

  it('never lets a concurrent reader see an empty or partial file', async () => {
    const dir = await fresh();
    const file = path.join(dir, 'exclude');
    await fsp.writeFile(file, BODY, 'utf8');

    const counts = await race(file, BODY, atomicRepositoryWrite);
    // The reader must have actually run; otherwise this proves nothing.
    assert.ok(counts.full > 0, `expected at least one complete read, got ${JSON.stringify(counts)}`);
    assert.equal(counts.empty, 0, `a reader saw an empty file: ${JSON.stringify(counts)}`);
    assert.equal(counts.partial, 0, `a reader saw a partial file: ${JSON.stringify(counts)}`);
    assert.equal(counts.refused, 0, `a reader was refused: ${JSON.stringify(counts)}`);
  });

  it('is falsifiable: the same race against fs.writeFile does fall into it', async () => {
    const dir = await fresh();
    const file = path.join(dir, 'exclude');
    await fsp.writeFile(file, BODY, 'utf8');

    const counts = await race(file, BODY, (target, data) => fsp.writeFile(target, data, 'utf8'));
    // This is the defect, reproduced: the non-atomic writer publishes the empty
    // file. If this ever stops happening the test above has become vacuous.
    assert.ok(
      counts.empty + counts.partial + counts.refused > 0,
      `expected fs.writeFile to expose the window, got ${JSON.stringify(counts)}`,
    );
  });

  it('replaces the file by rename rather than truncating it in place', async () => {
    const dir = await fresh();
    const file = path.join(dir, 'context.md');
    await fsp.writeFile(file, 'first\n', 'utf8');
    const before = await fsp.stat(file);

    await atomicRepositoryWrite(file, 'second\n');

    const after = await fsp.stat(file);
    assert.equal(await fsp.readFile(file, 'utf8'), 'second\n');
    // POSIX only. The inode is a sound witness for "renamed, not truncated"
    // where st_ino is a stable identity; on Windows it is an NTFS file index,
    // which carries no such guarantee across a replace — this assertion passed
    // and failed on consecutive runs of identical code before it was gated.
    //
    // Nothing is lost by scoping it. That the win32 path replaces by rename is
    // proven directly rather than inferred, by the injected-rename tests in
    // 'the Windows replace retry' below, and the property this whole file
    // exists for — no reader ever sees an empty or partial file — is asserted
    // on every platform by the race at the top of this suite.
    if (process.platform !== 'win32') {
      assert.notEqual(after.ino, before.ino, 'a truncate-in-place write would keep the inode');
    }
    // No temp file survives the write.
    assert.deepEqual((await fsp.readdir(dir)).sort(), ['context.md']);
  });

  it('preserves an existing file mode when replacing its inode', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX mode bits are not available on Windows');
      return;
    }
    const dir = await fresh();
    const file = path.join(dir, 'AGENTS.md');
    await fsp.writeFile(file, 'private instructions\n', { mode: 0o600 });

    await atomicRepositoryWrite(file, 'updated private instructions\n');

    assert.equal((await fsp.stat(file)).mode & 0o777, 0o600);
  });

  it('creates missing parent directories and writes ordinary, not owner-only, permissions', async () => {
    const dir = await fresh();
    const file = path.join(dir, 'nested', 'deeper', 'AGENTS.md');
    await atomicRepositoryWrite(file, 'body\n');
    assert.equal(await fsp.readFile(file, 'utf8'), 'body\n');
    if (process.platform !== 'win32') {
      // These are project files. 0600 here would make a repository unreadable to
      // anything else the user runs, and 0700 on the directory worse still.
      assert.notEqual((await fsp.stat(file)).mode & 0o777, 0o600);
      assert.notEqual((await fsp.stat(path.dirname(file))).mode & 0o777, 0o700);
    }
  });

  // The Windows replace path, driven on every platform through the injectable
  // rename. Relying on a Windows runner to cover this would mean the behaviour
  // is only ever exercised where it is slowest to observe — and it was a real
  // CI failure (EPERM from MoveFileEx while a reader held the destination open)
  // that put it here.
  describe('the Windows replace retry', () => {
    it('copies the existing Windows DACL to the replacement before rename', async () => {
      const dir = await fresh();
      const file = path.join(dir, 'private.json');
      await fsp.writeFile(file, 'original\n');
      let copied = false;
      await atomicRepositoryWrite(file, 'replacement\n', {
        platform: 'win32',
        copyWindowsAcl: async (source, destination) => {
          assert.equal(source, file);
          assert.equal(await fsp.readFile(destination, 'utf8'), 'replacement\n');
          copied = true;
        },
        rename: async (from, to) => {
          assert.equal(copied, true, 'the DACL must be copied before the replacement is published');
          await fsp.rename(from, to);
        },
      });
      assert.equal(await fsp.readFile(file, 'utf8'), 'replacement\n');
    });

    it('preserves the original when Windows DACL copying fails', async () => {
      const dir = await fresh();
      const file = path.join(dir, 'private.json');
      await fsp.writeFile(file, 'original\n');
      await assert.rejects(
        atomicRepositoryWrite(file, 'replacement\n', {
          platform: 'win32',
          copyWindowsAcl: async () => {
            throw Object.assign(new Error('cannot copy ACL'), { code: 'state-acl-copy-failed' });
          },
        }),
        (error) => error.code === 'state-acl-copy-failed',
      );
      assert.equal(await fsp.readFile(file, 'utf8'), 'original\n');
      assert.deepEqual(await fsp.readdir(dir), ['private.json']);
    });

    it('preserves a protected native Windows DACL across replacement', async (t) => {
      if (process.platform !== 'win32') {
        t.skip('native Windows ACLs require a Windows runner');
        return;
      }
      const dir = await fresh();
      const file = path.join(dir, 'private.json');
      await fsp.writeFile(file, 'original\n');
      const powershell = (script) => execFileSync('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script,
      ], {
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, NOOSPHERE_TEST_ACL_FILE: file },
      }).trim();
      const before = powershell(
        '$p=$env:NOOSPHERE_TEST_ACL_FILE; ' +
        '$s=[System.Security.AccessControl.AccessControlSections]::Access; ' +
        '$a=[System.IO.File]::GetAccessControl($p,$s); ' +
        '$a.SetAccessRuleProtection($true,$true); [System.IO.File]::SetAccessControl($p,$a); ' +
        '$a.GetSecurityDescriptorSddlForm($s)',
      );
      await atomicRepositoryWrite(file, 'replacement\n');
      const after = powershell(
        '$p=$env:NOOSPHERE_TEST_ACL_FILE; ' +
        '$s=[System.Security.AccessControl.AccessControlSections]::Access; ' +
        '[System.IO.File]::GetAccessControl($p,$s).GetSecurityDescriptorSddlForm($s)',
      );
      const canonicalAccess = (sddl) => sddl
        .replace(/^D:PAI/, 'D:P')
        .replaceAll(';ID;', ';;');
      assert.equal(canonicalAccess(after), canonicalAccess(before));
    });

    it('retries a destination held open by a reader, then succeeds', async () => {
      const dir = await fresh();
      const file = path.join(dir, 'exclude');
      let attempts = 0;
      await atomicRepositoryWrite(file, 'body\n', {
        platform: 'win32',
        rename: async (from, to) => {
          attempts += 1;
          // What MoveFileEx reports when the destination is open without
          // FILE_SHARE_DELETE.
          if (attempts < 3) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
          return fsp.rename(from, to);
        },
      });
      assert.equal(attempts, 3);
      assert.equal(await fsp.readFile(file, 'utf8'), 'body\n');
    });

    // The budget is spent here rather than waited out: `replaceBudgetMs` is the
    // same seam as `rename` and `platform`, so the give-up path is provable in
    // milliseconds instead of costing the suite the real 5 s ceiling.
    it('gives up on a wall-clock deadline rather than falling back to a truncating write', async () => {
      const dir = await fresh();
      const file = path.join(dir, 'exclude');
      await fsp.writeFile(file, 'original\n', 'utf8');
      let attempts = 0;
      const budget = 120;
      const started = Date.now();
      await assert.rejects(
        atomicRepositoryWrite(file, 'replacement\n', {
          platform: 'win32',
          copyWindowsAcl: async () => {},
          replaceBudgetMs: budget,
          rename: async () => {
            attempts += 1;
            throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' });
          },
        }),
        (error) => ['EBUSY', 'EPERM'].includes(error.code),
      );
      assert.ok(attempts > 1, 'the replace must have been retried');
      // A retry *count* would return here in whatever time N attempts happened
      // to take. Holding the elapsed time against the budget is what keeps the
      // ceiling a duration, so it cannot silently drop back under the 1200 ms
      // window the contention race below runs for.
      assert.ok(
        Date.now() - started >= budget,
        `the deadline must bound the retries, gave up after ${Date.now() - started}ms of ${budget}ms`,
      );
      // A silent fallback to fs.writeFile here would reintroduce the empty-file
      // window exactly when a reader is known to be holding the target.
      assert.equal(await fsp.readFile(file, 'utf8'), 'original\n');
      assert.deepEqual((await fsp.readdir(dir)).sort(), ['exclude']);
    });

    it('does not retry on POSIX, where rename has no such constraint', async () => {
      const dir = await fresh();
      const file = path.join(dir, 'exclude');
      let attempts = 0;
      await assert.rejects(
        atomicRepositoryWrite(file, 'body\n', {
          platform: 'linux',
          rename: async () => {
            attempts += 1;
            throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
          },
        }),
        (error) => error.code === 'EPERM',
      );
      assert.equal(attempts, 1, 'a POSIX EPERM is a real fault, not contention');
    });

    it('never retries an error that is not destination contention', async () => {
      const dir = await fresh();
      const file = path.join(dir, 'exclude');
      let attempts = 0;
      await assert.rejects(
        atomicRepositoryWrite(file, 'body\n', {
          platform: 'win32',
          rename: async () => {
            attempts += 1;
            throw Object.assign(new Error('ENOSPC: no space left on device, rename'), { code: 'ENOSPC' });
          },
        }),
        (error) => error.code === 'ENOSPC',
      );
      assert.equal(attempts, 1);
    });
  });

  it('refuses a symlinked target instead of replacing the link', async () => {
    const dir = await fresh();
    const real = path.join(dir, 'AGENTS.md');
    const link = path.join(dir, 'CLAUDE.md');
    await fsp.writeFile(real, 'user content\n', 'utf8');
    try {
      await fsp.symlink('AGENTS.md', link);
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return;
      throw error;
    }

    await assert.rejects(atomicRepositoryWrite(link, 'replacement\n'), (error) => {
      assert.equal(error.code, 'state-file-symlink');
      return true;
    });
    assert.equal(await fsp.readFile(real, 'utf8'), 'user content\n');
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.deepEqual((await fsp.readdir(dir)).sort(), ['AGENTS.md', 'CLAUDE.md']);
  });

  it('refuses a symlinked parent beneath an explicit repository root', async () => {
    const root = await fresh();
    const outside = await fresh();
    const link = path.join(root, '.noosphere');
    try {
      await fsp.symlink(outside, link, 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return;
      throw error;
    }

    await assert.rejects(
      atomicRepositoryWrite(path.join(link, 'context.md'), 'replacement\n', { root }),
      (error) => error.code === 'state-dir-symlink',
    );
    await assert.rejects(fsp.access(path.join(outside, 'context.md')));
  });

  it('appends without following a symlinked file or parent', async () => {
    const root = await fresh();
    const outside = await fresh();
    const outsideFile = path.join(outside, 'journal.md');
    await fsp.writeFile(outsideFile, 'outside\n');
    const finalLink = path.join(root, 'journal.md');
    try {
      await fsp.symlink(outsideFile, finalLink);
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return;
      throw error;
    }
    await assert.rejects(
      appendRepositoryFile(finalLink, 'attack\n', { root, maxBytes: 1024 }),
      (error) => error.code === 'state-file-symlink',
    );

    const parentLink = path.join(root, '.noosphere');
    await fsp.symlink(outside, parentLink, 'dir');
    await assert.rejects(
      appendRepositoryFile(path.join(parentLink, 'journal.md'), 'attack\n', {
        root,
        maxBytes: 1024,
      }),
      (error) => error.code === 'state-dir-symlink',
    );
    assert.equal(await fsp.readFile(outsideFile, 'utf8'), 'outside\n');
  });

  it('serializes concurrent bounded appends without dropping or duplicating bytes', async () => {
    const root = await fresh();
    const file = path.join(root, '.noosphere', 'journal.md');
    const lines = Array.from({ length: 32 }, (_, index) => `entry-${index}\n`);
    await Promise.all(lines.map((line) => appendRepositoryFile(file, line, {
      root,
      maxBytes: 4096,
      lockAttempts: 5000,
      lockBackoffMs: 2,
    })));
    const written = (await fsp.readFile(file, 'utf8')).trimEnd().split('\n').sort();
    assert.deepEqual(written, lines.map((line) => line.trim()).sort());
    assert.deepEqual((await fsp.readdir(path.dirname(file))).sort(), ['journal.md']);
  });

  it('serializes idempotent appends so one logical entry is written once', async () => {
    const root = await fresh();
    const file = path.join(root, '.noosphere', 'journal.md');
    const marker = '<!-- noosphere:session:session-42 -->';
    const entry = `${marker}\nfinished once\n`;
    const results = await Promise.all(Array.from({ length: 16 }, () =>
      appendRepositoryFile(file, entry, {
        root,
        maxBytes: 4096,
        skipIfContains: marker,
        lockAttempts: 5000,
        lockBackoffMs: 2,
      })));

    assert.equal(results.filter((result) => result.appended === true).length, 1);
    assert.equal(results.filter((result) => result.appended === false).length, 15);
    assert.equal(await fsp.readFile(file, 'utf8'), entry);
  });

  it('reclaims an append lock whose writer process is dead', async () => {
    const root = await fresh();
    const file = path.join(root, '.noosphere', 'journal.md');
    const lock = `${file}.append.lock`;
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(lock, JSON.stringify({
      pid: 2_147_483_647,
      token: '00000000-0000-4000-8000-000000000002',
      created_at: Date.now(),
    }));

    const result = await appendRepositoryFile(file, 'recovered\n', {
      root,
      maxBytes: 1024,
      lockAttempts: 5,
      lockBackoffMs: 1,
    });

    assert.equal(result.appended, true);
    assert.equal(await fsp.readFile(file, 'utf8'), 'recovered\n');
    await assert.rejects(fsp.access(lock));
  });

  it('never reclaims an append lock owned by a live writer', async () => {
    const root = await fresh();
    const file = path.join(root, 'journal.md');
    const lock = `${file}.append.lock`;
    const contents = JSON.stringify({
      pid: process.pid,
      token: '00000000-0000-4000-8000-000000000003',
      created_at: Date.now(),
    });
    await fsp.writeFile(lock, contents);

    await assert.rejects(
      appendRepositoryFile(file, 'must-not-land\n', {
        root,
        maxBytes: 1024,
        lockAttempts: 3,
        lockBackoffMs: 1,
      }),
      (error) => error.code === 'state-append-busy',
    );
    assert.equal(await fsp.readFile(lock, 'utf8'), contents);
    await assert.rejects(fsp.access(file));
  });

  // Reclaiming means deleting another process's lock, so "not alive" has to mean
  // the OS said the process is gone — not merely that asking about it failed.
  // EPERM is the answer for a process that exists but belongs to another user;
  // treating any signal failure as death would reclaim a live owner's lock and
  // let two writers into the same critical section.
  it('never reclaims an append lock owned by a process it may not signal', async (t) => {
    let unsignalable = null;
    try {
      process.kill(1, 0);
    } catch (error) {
      if (error.code === 'EPERM') unsignalable = 1;
    }
    if (unsignalable === null) {
      t.diagnostic('no live-but-unsignalable process is available to this user');
      return;
    }

    const root = await fresh();
    const file = path.join(root, 'journal.md');
    const lock = `${file}.append.lock`;
    const contents = JSON.stringify({
      pid: unsignalable,
      token: '00000000-0000-4000-8000-00000000000e',
      created_at: Date.now(),
    });
    await fsp.writeFile(lock, contents);

    await assert.rejects(
      appendRepositoryFile(file, 'must-not-land\n', {
        root,
        maxBytes: 1024,
        lockAttempts: 3,
        lockBackoffMs: 1,
      }),
      (error) => error.code === 'state-append-busy',
    );
    assert.equal(await fsp.readFile(lock, 'utf8'), contents);
    await assert.rejects(fsp.access(file));
  });

  it('never reclaims malformed append-lock metadata merely because it is old', async () => {
    const root = await fresh();
    const file = path.join(root, 'journal.md');
    const lock = `${file}.append.lock`;
    await fsp.writeFile(lock, '{malformed');
    await fsp.utimes(lock, new Date(0), new Date(0));

    await assert.rejects(
      appendRepositoryFile(file, 'must-not-land\n', {
        root,
        maxBytes: 1024,
        lockAttempts: 2,
        lockBackoffMs: 0,
      }),
      (error) => error.code === 'state-append-busy',
    );
    assert.equal(await fsp.readFile(lock, 'utf8'), '{malformed');
    await assert.rejects(fsp.access(file));
  });

  it('recovers a process guard left by a killed append-lock reclaimer', async () => {
    const root = await fresh();
    const file = path.join(root, 'journal.md');
    const lock = `${file}.append.lock`;
    const guard = `${lock}.reclaim`;
    await fsp.writeFile(lock, JSON.stringify({
      pid: 2_147_483_647,
      token: '00000000-0000-4000-8000-000000000004',
      created_at: Date.now(),
    }));
    await fsp.mkdir(guard);
    await fsp.writeFile(
      path.join(guard, 'owner-2147483647-00000000-0000-4000-8000-000000000005'),
      '',
    );

    const result = await appendRepositoryFile(file, 'recovered-twice\n', {
      root,
      maxBytes: 1024,
      lockAttempts: 5,
      lockBackoffMs: 0,
    });

    assert.equal(result.appended, true);
    assert.equal(await fsp.readFile(file, 'utf8'), 'recovered-twice\n');
    await assert.rejects(fsp.access(lock));
    await assert.rejects(fsp.access(guard));
  });

  it('serializes every waiter while one of them reclaims a dead append lock', async () => {
    const root = await fresh();
    const file = path.join(root, 'journal.md');
    const lock = `${file}.append.lock`;
    await fsp.writeFile(lock, JSON.stringify({
      pid: 2_147_483_647,
      token: '00000000-0000-4000-8000-000000000008',
      created_at: Date.now(),
    }));
    const lines = Array.from({ length: 24 }, (_, index) => `reclaim-${index}\n`);

    await Promise.all(lines.map((line) => appendRepositoryFile(file, line, {
      root,
      maxBytes: 4096,
      lockAttempts: 5000,
      lockBackoffMs: 1,
    })));

    const written = (await fsp.readFile(file, 'utf8')).trimEnd().split('\n').sort();
    assert.deepEqual(written, lines.map((line) => line.trim()).sort());
    await assert.rejects(fsp.access(lock));
    await assert.rejects(fsp.access(`${lock}.reclaim`));
  });

  it('does not reclaim a process guard owned by a live reclaimer', async () => {
    const root = await fresh();
    const file = path.join(root, 'journal.md');
    const lock = `${file}.append.lock`;
    const guard = `${lock}.reclaim`;
    await fsp.writeFile(lock, JSON.stringify({
      pid: 2_147_483_647,
      token: '00000000-0000-4000-8000-000000000009',
      created_at: Date.now(),
    }));
    await fsp.mkdir(guard);
    const marker = `owner-${process.pid}-00000000-0000-4000-8000-00000000000a`;
    await fsp.writeFile(path.join(guard, marker), '');

    await assert.rejects(
      appendRepositoryFile(file, 'must-not-land\n', {
        root,
        maxBytes: 1024,
        lockAttempts: 3,
        lockBackoffMs: 0,
      }),
      (error) => error.code === 'state-append-busy',
    );
    assert.equal((await fsp.readdir(guard)).join(''), marker);
    await assert.rejects(fsp.access(file));
  });

  it('recognizes and cleans the exact AppleDouble companion of a process-guard marker', async () => {
    const root = await fresh();
    const guard = path.join(root, 'journal.md.append.lock.reclaim');
    const liveMarker = `owner-${process.pid}-00000000-0000-4000-8000-00000000000b`;
    await fsp.mkdir(guard);
    await fsp.writeFile(path.join(guard, liveMarker), '');
    await fsp.writeFile(path.join(guard, `._${liveMarker}`), 'appledouble');

    assert.equal(await tryAcquireOwnerProcessGuard(guard, { root }), null);
    assert.deepEqual((await fsp.readdir(guard)).sort(), [`._${liveMarker}`, liveMarker].sort());

    await fsp.rm(guard, { recursive: true });
    const deadMarker = 'owner-2147483647-00000000-0000-4000-8000-00000000000c';
    await fsp.mkdir(guard);
    await fsp.writeFile(path.join(guard, deadMarker), '');
    await fsp.writeFile(path.join(guard, `._${deadMarker}`), 'appledouble');

    const acquired = await tryAcquireOwnerProcessGuard(guard, { root });
    assert.ok(acquired);
    await acquired.release();
    await assert.rejects(fsp.access(guard));
  });

  it('still rejects unrelated or malformed process-guard companions', async () => {
    const root = await fresh();
    const guard = path.join(root, 'journal.md.append.lock.reclaim');
    const marker = `owner-${process.pid}-00000000-0000-4000-8000-00000000000d`;
    await fsp.mkdir(guard);
    await fsp.writeFile(path.join(guard, marker), '');
    await fsp.writeFile(path.join(guard, '._different-marker'), 'appledouble');

    await assert.rejects(
      tryAcquireOwnerProcessGuard(guard, { root }),
      (error) => error.code === 'state-process-guard-unsafe',
    );
  });

  it('serializes the size check so concurrent appends cannot exceed the bound', async () => {
    const root = await fresh();
    const file = path.join(root, 'journal.md');
    await fsp.writeFile(file, '12345');
    const results = await Promise.allSettled([
      appendRepositoryFile(file, 'abc', { root, maxBytes: 8 }),
      appendRepositoryFile(file, 'xyz', { root, maxBytes: 8 }),
    ]);
    assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
    assert.equal(results.filter(({ status }) => status === 'rejected').length, 1);
    assert.equal((await fsp.readFile(file)).length, 8);
  });

  it('retries a verified Windows lock when open reports sharing contention', async () => {
    const root = await fresh();
    const file = path.join(root, 'journal.md');
    const lock = `${file}.append.lock`;
    await fsp.writeFile(lock, 'held');
    let calls = 0;
    await appendRepositoryFile(file, 'entry\n', {
      root,
      platform: 'win32',
      maxBytes: 1024,
      lockBackoffMs: 1,
      open: async (...args) => {
        calls += 1;
        if (calls === 1) {
          throw Object.assign(new Error('sharing violation'), { code: 'EPERM' });
        }
        await fsp.rm(lock);
        return fsp.open(...args);
      },
    });
    assert.equal(await fsp.readFile(file, 'utf8'), 'entry\n');
    assert.equal(calls, 2);
  });

  it('bounds persistent Windows sharing errors with the overall lock budget', async () => {
    const root = await fresh();
    let calls = 0;
    await assert.rejects(
      appendRepositoryFile(path.join(root, 'journal.md'), 'entry\n', {
        root,
        platform: 'win32',
        maxBytes: 1024,
        lockAttempts: 3,
        lockBackoffMs: 1,
        open: async () => {
          calls += 1;
          throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
        },
      }),
      (error) => error.code === 'state-append-busy'
        && error.message.includes(`${path.join(root, 'journal.md')}.append.lock`),
    );
    assert.equal(calls, 3);
  });

  it('treats disappearance during repository-file removal as already removed', async () => {
    const root = await fresh();
    const file = path.join(root, 'adapter.md');
    await fsp.writeFile(file, 'managed\n');
    assert.equal(await removeRepositoryFile(file, {
      root,
      rm: async () => {
        await fsp.rm(file);
        throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      },
    }), false);
  });

  it('removes only regular files and real empty directories under the repository root', async () => {
    const root = await fresh();
    const outside = await fresh();
    const outsideFile = path.join(outside, 'mcp.json');
    await fsp.writeFile(outsideFile, 'outside\n');
    const cursor = path.join(root, '.cursor');
    try {
      await fsp.symlink(outside, cursor, 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return;
      throw error;
    }
    await assert.rejects(
      removeRepositoryFile(path.join(cursor, 'mcp.json'), { root }),
      (error) => error.code === 'state-dir-symlink',
    );
    await assert.rejects(
      removeRepositoryDirectoryIfEmpty(cursor, { root }),
      (error) => error.code === 'state-dir-symlink',
    );
    assert.equal(await fsp.readFile(outsideFile, 'utf8'), 'outside\n');
  });
});
