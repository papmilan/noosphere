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

// A hole, not a payload. Returns the bytes the filesystem actually allocated so
// a test can prove the fixture is sparse instead of assuming it.
function sparse(file, size) {
  const fd = fs.openSync(file, 'w');
  try {
    fs.ftruncateSync(fd, size);
  } finally {
    fs.closeSync(fd);
  }
  const stats = fs.statSync(file);
  assert.equal(stats.size, size);
  return typeof stats.blocks === 'number' ? stats.blocks * 512 : null;
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
    const size = 8 * 1024 * 1024 * 1024;
    const allocated = sparse(file, size);
    if (allocated !== null) {
      assert.ok(allocated < size / 1000, `fixture is not sparse: ${allocated} bytes allocated`);
    }

    const started = process.hrtime.bigint();
    await assert.rejects(
      readBoundedRegularFile(file, { maxBytes: 1024 * 1024 }),
      (error) => error.code === 'state-file-too-large',
    );
    // Not a performance assertion — a refusal that had to read 8 GiB could not
    // finish in this window on any real machine, so this fails if the size check
    // ever moves after the read.
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
