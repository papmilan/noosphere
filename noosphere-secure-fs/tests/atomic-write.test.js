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
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { atomicRepositoryWrite, readBoundedRegularFile } from '../index.js';

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
    assert.ok(counts.full > 100, `expected many complete reads, got ${JSON.stringify(counts)}`);
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
    assert.notEqual(after.ino, before.ino, 'a truncate-in-place write would keep the inode');
    // No temp file survives the write.
    assert.deepEqual((await fsp.readdir(dir)).sort(), ['context.md']);
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

    it('gives up rather than falling back to a truncating write', async () => {
      const dir = await fresh();
      const file = path.join(dir, 'exclude');
      await fsp.writeFile(file, 'original\n', 'utf8');
      let attempts = 0;
      await assert.rejects(
        atomicRepositoryWrite(file, 'replacement\n', {
          platform: 'win32',
          rename: async () => {
            attempts += 1;
            throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' });
          },
        }),
        (error) => ['EBUSY', 'EPERM'].includes(error.code),
      );
      assert.ok(attempts > 1, 'the replace must have been retried');
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
});
