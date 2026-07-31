import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  isProcessAlive,
  isStale,
  readManagerMarker,
  recordManagerStart,
  runtimeMarkerPath,
  sourceStamp,
} from '../lifecycle/service-state.js';

const tmpDirs = [];

after(async () => {
  await Promise.all(tmpDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tmp(prefix) {
  const { realpath, mkdtemp: make } = await import('node:fs/promises');
  const dir = await realpath(await make(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
}

async function fakePackage(stampMs) {
  const root = await tmp('noosphere-service-state-');
  const file = path.join(root, 'package.json');
  await writeFile(file, '{"name":"fake"}\n');
  if (stampMs) {
    const { utimes } = await import('node:fs/promises');
    await utimes(file, new Date(stampMs), new Date(stampMs));
  }
  return root;
}

describe('stale service detection', () => {
  it('round-trips the marker through NOOSPHERE_HOME', async () => {
    const home = await tmp('noosphere-home-');
    const root = await fakePackage();
    const env = { NOOSPHERE_HOME: home };

    const written = await recordManagerStart(root, env);
    assert.equal(written.pid, process.pid);
    assert.equal(written.source_root, root);
    assert.equal(typeof written.source_stamp, 'number');

    const read = await readManagerMarker(env);
    assert.deepEqual(read, written);
    // The marker must land inside the resolved home, not the real one.
    assert.equal(runtimeMarkerPath(env), path.join(home, 'manager-runtime.json'));
    assert.match(await readFile(runtimeMarkerPath(env), 'utf8'), /source_stamp/);
  });

  it('reports code newer than the running process as stale', async () => {
    const root = await fakePackage();
    const stamp = await sourceStamp(root);
    const marker = { pid: process.pid, source_root: root, source_stamp: stamp };

    assert.equal(isStale(marker, stamp, root), false, 'same build is current');
    assert.equal(
      isStale(marker, stamp + 1_000, root),
      true,
      'a newer install than the running process is stale',
    );
  });

  it('returns unknown rather than failing when it cannot tell', async () => {
    const root = await fakePackage();
    const stamp = await sourceStamp(root);

    assert.equal(isStale(null, stamp, root), null, 'no marker');
    assert.equal(isStale({ pid: process.pid }, stamp, root), null, 'no stamp');
    assert.equal(
      isStale({ pid: process.pid, source_stamp: stamp }, null, root),
      null,
      'installed stamp unreadable',
    );

    // A manager started from a checkout says nothing about the installed copy.
    const other = await fakePackage();
    assert.equal(
      isStale(
        { pid: process.pid, source_root: other, source_stamp: stamp },
        stamp + 1_000,
        root,
      ),
      null,
      'different source root must not report a phantom upgrade',
    );

    // A dead manager is not a stale manager; it is a stopped one.
    assert.equal(
      isStale(
        { pid: 0x7ffffffe, source_root: root, source_stamp: stamp },
        stamp + 1_000,
        root,
      ),
      null,
      'no running process to be stale',
    );
  });

  it('detects liveness without signalling the process', () => {
    assert.equal(isProcessAlive(process.pid), true);
    assert.equal(isProcessAlive(0x7ffffffe), false);
    assert.equal(isProcessAlive(-1), false);
    assert.equal(isProcessAlive(undefined), false);
  });
});
