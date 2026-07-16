import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { assertRealDirectory, PathBoundaryError } from '../secure-fs.js';
import { CredentialStore } from '../credentials.js';
import { LocalMemoryStore } from '../local-memory.js';

const dirs = [];
after(async () => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));
async function tempBase() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'noosphere-relayer-securefs-'));
  dirs.push(dir);
  return dir;
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

  it('assertRealDirectory accepts a real directory', async () => {
    const base = await tempBase();
    const info = await assertRealDirectory(base);
    assert.equal(info.isDirectory(), true);
  });
});
