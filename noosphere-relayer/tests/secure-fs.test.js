import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { assertRealDirectory, PathBoundaryError } from '../secure-fs.js';
import { CredentialStore } from '../credentials.js';
import { DurableStore } from '../durable-store.js';
import { LocalMemoryStore } from '../local-memory.js';

const dirs = [];
after(async () => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));
async function tempBase() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'noosphere-relayer-securefs-'));
  dirs.push(dir);
  return dir;
}

async function plantSentinel(outside) {
  await mkdir(outside, { recursive: true, mode: 0o700 });
  const sentinel = path.join(outside, 'KEEP.txt');
  await writeFile(sentinel, 'inert-sentinel', { mode: 0o600 });
  return {
    directoryMode: (await stat(outside)).mode,
    sentinel,
  };
}

async function assertSentinelOnly(outside, before) {
  assert.deepEqual(await readdir(outside), ['KEEP.txt'], 'no JSON, temp file, or directory may be created outside');
  assert.equal(await readFile(before.sentinel, 'utf8'), 'inert-sentinel', 'outside sentinel must survive unchanged');
  assert.equal((await stat(outside)).mode, before.directoryMode, 'outside directory permissions must not change');
}

function isSymlinkBoundary(error) {
  return error instanceof PathBoundaryError && error.code === 'state-dir-symlink';
}

describe('relayer secure-fs — SEC-03', () => {
  it('credential fallback refuses a symlinked ~/.noosphere directory', async () => {
    const base = await tempBase();
    const home = path.join(base, 'home');
    const outside = path.join(base, 'outside');
    await mkdir(home, { recursive: true });
    await mkdir(outside, { recursive: true });
    // Attacker plants ~/.noosphere as a symlink to a directory they can read.
    await symlink(outside, path.join(home, '.noosphere'));

    const store = new CredentialStore('default', { platform: 'linux', home, run: () => ({ status: 1 }) });
    assert.throws(() => store.setPassword('super-secret'), (error) => error instanceof PathBoundaryError);
    assert.deepEqual(await readdir(outside), [], 'secret must not be written into the symlink target');
  });

  it('credential fallback refuses a symlinked credential file', async () => {
    const base = await tempBase();
    const home = path.join(base, 'home');
    const stolen = path.join(base, 'stolen.txt');
    await mkdir(path.join(home, '.noosphere'), { recursive: true });
    await writeFile(stolen, 'placeholder');
    await symlink(stolen, path.join(home, '.noosphere', 'credentials-default.json'));

    const store = new CredentialStore('default', { platform: 'linux', home, run: () => ({ status: 1 }) });
    assert.throws(() => store.setPassword('super-secret'), (error) => error instanceof PathBoundaryError);
    assert.equal(await readFile(stolen, 'utf8'), 'placeholder', 'secret must not be written through the symlink');
  });

  it('local memory refuses a symlinked directory', async () => {
    const base = await tempBase();
    const outside = path.join(base, 'outside');
    const linked = path.join(base, 'linked');
    await mkdir(outside, { recursive: true });
    await symlink(outside, linked);
    const store = new LocalMemoryStore(
      { NODE_ENV: 'production', LOCAL_MEMORY_PATH: path.join(linked, 'mem.json') },
      { defaultPath: path.join(linked, 'mem.json') },
    );
    await assert.rejects(store.remember('p', 'ns', 'text'), (error) => error instanceof PathBoundaryError);
    assert.deepEqual(await readdir(outside), [], 'memory must not be written into the symlink target');
  });

  it('DurableStore refuses a nested parent symlink before creating descendants', async () => {
    const base = await tempBase();
    const intended = path.join(base, 'intended');
    const outside = path.join(base, 'outside');
    await mkdir(intended, { recursive: true });
    const before = await plantSentinel(outside);
    await symlink(outside, path.join(intended, 'linked'), 'dir');

    const store = new DurableStore({
      filePath: path.join(intended, 'linked', 'missing', 'state.json'),
    });
    await assert.rejects(store.writeState(), isSymlinkBoundary);
    await assertSentinelOnly(outside, before);
  });

  it('LocalMemoryStore refuses a nested parent symlink before creating descendants', async () => {
    const base = await tempBase();
    const intended = path.join(base, 'intended');
    const outside = path.join(base, 'outside');
    await mkdir(intended, { recursive: true });
    const before = await plantSentinel(outside);
    await symlink(outside, path.join(intended, 'linked'), 'dir');
    const filePath = path.join(intended, 'linked', 'missing', 'memory.json');
    const store = new LocalMemoryStore(
      { NODE_ENV: 'production', LOCAL_MEMORY_PATH: filePath },
      { defaultPath: filePath },
    );

    await assert.rejects(store.remember('p', 'ns', 'text'), isSymlinkBoundary);
    await assertSentinelOnly(outside, before);
  });

  it('both stores refuse when the final directory itself is symlinked', async () => {
    const base = await tempBase();
    const intended = path.join(base, 'intended');
    const outside = path.join(base, 'outside');
    await mkdir(intended, { recursive: true });
    const before = await plantSentinel(outside);
    await symlink(outside, path.join(intended, 'final'), 'dir');

    const store = new DurableStore({ filePath: path.join(intended, 'final', 'state.json') });
    await assert.rejects(store.writeState(), isSymlinkBoundary);

    await symlink(outside, path.join(intended, 'memory-final'), 'dir');
    const memoryPath = path.join(intended, 'memory-final', 'memory.json');
    const memory = new LocalMemoryStore(
      { NODE_ENV: 'production', LOCAL_MEMORY_PATH: memoryPath },
      { defaultPath: memoryPath },
    );
    await assert.rejects(memory.remember('p', 'ns', 'text'), isSymlinkBoundary);
    await assertSentinelOnly(outside, before);
  });

  it('both stores preserve mixed existing and missing nested directories', async () => {
    const base = await tempBase();
    const existing = path.join(base, 'intended', 'existing');
    await mkdir(existing, { recursive: true });

    const statePath = path.join(existing, 'new-state', 'deep', 'state.json');
    await new DurableStore({ filePath: statePath }).writeState();
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).version, 1);

    const memoryPath = path.join(existing, 'new-memory', 'deep', 'memory.json');
    const memory = new LocalMemoryStore(
      { NODE_ENV: 'production', LOCAL_MEMORY_PATH: memoryPath },
      { defaultPath: memoryPath },
    );
    await memory.remember('p', 'ns', 'text');
    assert.equal(JSON.parse(await readFile(memoryPath, 'utf8')).projects.p.length, 1);
  });

  it('both stores refuse a nested Windows junction before creating descendants', {
    skip: process.platform !== 'win32' ? 'Windows junction coverage' : false,
  }, async () => {
    const base = await tempBase();
    const intended = path.join(base, 'intended');
    const outside = path.join(base, 'outside');
    await mkdir(intended, { recursive: true });
    const before = await plantSentinel(outside);
    await symlink(outside, path.join(intended, 'state-linked'), 'junction');

    const store = new DurableStore({
      filePath: path.join(intended, 'state-linked', 'missing', 'state.json'),
    });
    await assert.rejects(store.writeState(), isSymlinkBoundary);

    await symlink(outside, path.join(intended, 'memory-linked'), 'junction');
    const memoryPath = path.join(intended, 'memory-linked', 'missing', 'memory.json');
    const memory = new LocalMemoryStore(
      { NODE_ENV: 'production', LOCAL_MEMORY_PATH: memoryPath },
      { defaultPath: memoryPath },
    );
    await assert.rejects(memory.remember('p', 'ns', 'text'), isSymlinkBoundary);
    await assertSentinelOnly(outside, before);
  });

  it('assertRealDirectory accepts a real directory', async () => {
    const base = await tempBase();
    const info = await assertRealDirectory(base);
    assert.equal(info.isDirectory(), true);
  });
});
