// The bounded regular-file read primitive, tested at its own package boundary.
//
// This is the one read used for every file whose content, type, and size are
// controlled by something other than the process doing the reading. The
// properties below are the whole reason it exists, so each is asserted against
// a real filesystem object rather than a mock.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { readBoundedRegularFile, readBoundedRegularFileSync } from '../index.js';

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'bounded-read-'));
}

function mkfifo(file) {
  if (process.platform === 'win32') return false;
  try {
    execFileSync('mkfifo', [file]);
  } catch {
    return false;
  }
  return fs.lstatSync(file).isFIFO();
}

function trySymlink(target, file) {
  try {
    fs.symlinkSync(target, file);
    return true;
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return false;
    throw error;
  }
}

// An oversized fixture, sparse wherever the filesystem supports it. APFS and
// ext4 give a real hole for the cost of one ftruncate; NTFS allocates instead
// and a multi-GiB request returns ENOSPC on a CI runner, so there the fixture
// falls back to `bound + 1` real bytes. Returns { size, sparse }.
function oversized(file, bound) {
  const hole = bound * 4096;
  const fd = fs.openSync(file, 'w');
  try {
    try {
      fs.ftruncateSync(fd, hole);
      const stats = fs.statSync(file);
      const allocated = typeof stats.blocks === 'number' ? stats.blocks * 512 : 0;
      if (stats.size === hole && allocated < hole / 1000) return { size: hole, sparse: true };
    } catch (error) {
      if (error.code !== 'ENOSPC') throw error;
    }
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, Buffer.alloc(bound + 1, 0x41), 0, bound + 1, 0);
    return { size: bound + 1, sparse: false };
  } finally {
    fs.closeSync(fd);
  }
}

describe('readBoundedRegularFile', () => {
  test('reads an ordinary file byte-for-byte and reports absence as null', async () => {
    const dir = temporaryDirectory();
    const file = path.join(dir, 'ordinary.txt');
    const bytes = Buffer.from('hello\nworld\n', 'utf8');
    fs.writeFileSync(file, bytes);

    assert.deepEqual(await readBoundedRegularFile(file, { maxBytes: 1024 }), bytes);
    assert.deepEqual(readBoundedRegularFileSync(file, { maxBytes: 1024 }), bytes);
    assert.equal(await readBoundedRegularFile(path.join(dir, 'nope'), { maxBytes: 1024 }), null);
    assert.equal(readBoundedRegularFileSync(path.join(dir, 'nope'), { maxBytes: 1024 }), null);
  });

  test('accepts exactly maxBytes and refuses maxBytes + 1', async () => {
    const dir = temporaryDirectory();
    const file = path.join(dir, 'boundary.bin');

    fs.writeFileSync(file, Buffer.alloc(64, 0x41));
    assert.equal((await readBoundedRegularFile(file, { maxBytes: 64 })).length, 64);

    fs.writeFileSync(file, Buffer.alloc(65, 0x41));
    await assert.rejects(
      readBoundedRegularFile(file, { maxBytes: 64 }),
      (error) => error.code === 'state-file-too-large',
    );
    assert.throws(
      () => readBoundedRegularFileSync(file, { maxBytes: 64 }),
      (error) => error.code === 'state-file-too-large',
    );
  });

  test('refuses a sparse oversized file without allocating it', async () => {
    const dir = temporaryDirectory();
    const file = path.join(dir, 'sparse.bin');
    const bound = 1024 * 1024;
    const fixture = oversized(file, bound);
    // POSIX must produce a real hole; if it stopped, this test would still pass
    // while proving far less.
    if (process.platform !== 'win32') {
      assert.equal(fixture.sparse, true, 'the POSIX fixture was not sparse');
    }

    const started = process.hrtime.bigint();
    await assert.rejects(
      readBoundedRegularFile(file, { maxBytes: bound }),
      (error) => error.code === 'state-file-too-large',
    );
    // Not a performance assertion — a refusal that had to materialise a 4 GiB
    // hole could not finish in this window, so this fails if the size check ever
    // moves after the read.
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 5_000, `the refusal took ${elapsedMs}ms, which implies the file was read`);
  });

  test('rejects a non-integer or negative bound instead of reading unbounded', async () => {
    const dir = temporaryDirectory();
    const file = path.join(dir, 'ordinary.txt');
    fs.writeFileSync(file, 'x');
    for (const maxBytes of [undefined, -1, 1.5, Number.NaN, '1024']) {
      await assert.rejects(
        readBoundedRegularFile(file, { maxBytes }),
        (error) => error.code === 'state-read-bound-invalid',
        `maxBytes=${String(maxBytes)}`,
      );
    }
  });

  test('refuses a directory with EISDIR', async () => {
    const dir = temporaryDirectory();
    const target = path.join(dir, 'a-directory');
    fs.mkdirSync(target);
    await assert.rejects(
      readBoundedRegularFile(target, { maxBytes: 1024 }),
      (error) => error.code === 'EISDIR',
    );
  });

  test('opens and refuses a FIFO instead of blocking on it', async (t) => {
    const dir = temporaryDirectory();
    const file = path.join(dir, 'a-fifo');
    if (!mkfifo(file)) {
      t.skip('this platform cannot create a FIFO');
      return;
    }
    // Termination is the property: O_RDONLY without O_NONBLOCK blocks in open(2)
    // until a writer appears, and no error code is ever produced.
    let timer;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('the FIFO read blocked')), 5_000);
    });
    try {
      await Promise.race([
        assert.rejects(
          readBoundedRegularFile(file, { maxBytes: 1024 }),
          (error) => error.code === 'state-file-not-regular',
        ),
        guard,
      ]);
    } finally {
      clearTimeout(timer);
    }
  });

  test('refuses a symlinked file without following it', async (t) => {
    const dir = temporaryDirectory();
    const target = path.join(dir, 'target.txt');
    const link = path.join(dir, 'link.txt');
    fs.writeFileSync(target, 'SECRET');
    if (!trySymlink(target, link)) {
      t.skip('this platform cannot create symlinks without elevation');
      return;
    }
    if (process.platform === 'win32') {
      // O_NOFOLLOW does not exist here; the pre-open lstat is the guard and the
      // residual TOCTOU window is documented.
      await assert.rejects(
        readBoundedRegularFile(link, { maxBytes: 1024 }),
        (error) => error.code === 'state-file-symlink',
      );
      return;
    }
    await assert.rejects(
      readBoundedRegularFile(link, { maxBytes: 1024 }),
      (error) => error.code === 'state-file-symlink',
    );
    assert.throws(
      () => readBoundedRegularFileSync(link, { maxBytes: 1024 }),
      (error) => error.code === 'state-file-symlink',
    );
  });

  test('reads through a symlinked PARENT directory — the documented distinction', async (t) => {
    const dir = temporaryDirectory();
    const real = path.join(dir, 'real');
    const linked = path.join(dir, 'linked');
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, 'file.txt'), 'CONTENT');
    if (!trySymlink(real, linked)) {
      t.skip('this platform cannot create symlinks without elevation');
      return;
    }
    assert.equal(
      (await readBoundedRegularFile(path.join(linked, 'file.txt'), { maxBytes: 1024 })).toString('utf8'),
      'CONTENT',
    );
  });
});
