import assert from 'node:assert/strict';
import { open, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  DEFAULT_MAX_BYTES,
  maxLogBytes,
  rotateFile,
  rotateLogs,
} from '../lifecycle/log-rotation.js';

const tmpDirs = [];

after(async () => {
  await Promise.all(tmpDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tmp() {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'noosphere-logs-')));
  tmpDirs.push(dir);
  return dir;
}

describe('service log rotation', () => {
  it('keeps the inode so an open descriptor keeps working', async () => {
    // The property the whole approach rests on. launchd and systemd hold the
    // descriptor; if rotation ever became rename-based, the service would go on
    // writing to the renamed inode and the live log would stay empty. This test
    // is what fails if someone "improves" it that way.
    const dir = await tmp();
    const file = path.join(dir, 'manager.log');
    await writeFile(file, 'x'.repeat(200));

    const before = await stat(file);
    const handle = await open(file, 'a');
    try {
      assert.equal(await rotateFile(file, 100), true);

      const after = await stat(file);
      assert.equal(after.ino, before.ino, 'rotation must not replace the inode');
      assert.equal(after.size, 0, 'the live file is emptied, not removed');

      // The descriptor opened before rotation must still reach the live file.
      await handle.write('after rotation\n');
      assert.match(await readFile(file, 'utf8'), /after rotation/);
    } finally {
      await handle.close();
    }

    assert.equal((await readFile(`${file}.1`, 'utf8')).length, 200);
  });

  it('leaves a file that is under the cap alone', async () => {
    const dir = await tmp();
    const file = path.join(dir, 'manager.log');
    await writeFile(file, 'small');

    assert.equal(await rotateFile(file, DEFAULT_MAX_BYTES), false);
    assert.equal(await readFile(file, 'utf8'), 'small');
    await assert.rejects(stat(`${file}.1`), 'no generation for an untouched log');
  });

  it('rotates every log in the directory and never a generation', async () => {
    const dir = await tmp();
    for (const name of ['manager.log', 'manager.error.log', 'relayer.log']) {
      await writeFile(path.join(dir, name), 'y'.repeat(500));
    }
    await writeFile(path.join(dir, 'notes.txt'), 'z'.repeat(500));

    const first = await rotateLogs(dir, 100);
    assert.deepEqual(
      first.sort(),
      ['manager.error.log', 'manager.log', 'relayer.log'],
      'only .log files rotate',
    );
    assert.equal((await readFile(path.join(dir, 'notes.txt'), 'utf8')).length, 500);

    // Everything is empty now, and the .log.1 generations must not be picked up
    // on the next pass — otherwise each sweep would discard the kept copy.
    const second = await rotateLogs(dir, 100);
    assert.deepEqual(second, [], 'nothing left over the cap');
    assert.equal(
      (await readFile(path.join(dir, 'manager.log.1'), 'utf8')).length,
      500,
      'the kept generation survives a later sweep',
    );
  });

  it('replaces the previous generation rather than growing without bound', async () => {
    const dir = await tmp();
    const file = path.join(dir, 'manager.log');

    await writeFile(file, 'first'.repeat(100));
    assert.equal(await rotateFile(file, 10), true);
    await writeFile(file, 'second'.repeat(100));
    assert.equal(await rotateFile(file, 10), true);

    assert.match(await readFile(`${file}.1`, 'utf8'), /second/);
    await assert.rejects(stat(`${file}.2`), 'only one generation is kept');
  });

  it('reads the cap from the environment and falls back sanely', () => {
    assert.equal(maxLogBytes({}), DEFAULT_MAX_BYTES);
    assert.equal(maxLogBytes({ NOOSPHERE_LOG_MAX_BYTES: '1024' }), 1024);
    assert.equal(maxLogBytes({ NOOSPHERE_LOG_MAX_BYTES: 'nonsense' }), DEFAULT_MAX_BYTES);
    assert.equal(maxLogBytes({ NOOSPHERE_LOG_MAX_BYTES: '0' }), DEFAULT_MAX_BYTES);
    assert.equal(maxLogBytes({ NOOSPHERE_LOG_MAX_BYTES: '-5' }), DEFAULT_MAX_BYTES);
  });

  it('ignores a missing directory or file instead of throwing', async () => {
    assert.deepEqual(await rotateLogs('/nonexistent/noosphere/logs', 100), []);
    assert.equal(await rotateFile('/nonexistent/noosphere/manager.log', 100), false);
  });
});
