import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import {
  AUTH_DOMAINS,
  verifyRecord,
} from '../continuity/internal/authenticated-records.js';
import { assertOwnerOnlyFile } from './file-security.js';

const keyModule = await import(
  '../continuity/internal/replay/key.js'
).catch(() => null);

const temporary = [];

after(async () => {
  await Promise.all(temporary.map(directory =>
    fs.rm(directory, { recursive: true, force: true })));
});

async function environment() {
  const home = await fs.mkdtemp(
    path.join(os.tmpdir(), 'noosphere-replay-key-'),
  );
  temporary.push(home);
  return {
    home,
    env: {
      NOOSPHERE_HOME: home,
      NOOSPHERE_OWNER_SCOPE: 'phase5-owner',
    },
  };
}

function paths(home) {
  const root = path.join(home, 'replay-v1');
  return {
    root,
    key: path.join(root, 'machine.key'),
    catalog: path.join(root, 'catalog.json'),
  };
}

test('pristine first use creates one replay-only key and authenticated catalog', async () => {
  assert.ok(keyModule, 'production replay key module must exist');
  const { home, env } = await environment();
  const expectedPaths = paths(home);
  const key = await keyModule.ensureReplayKey({ env });

  assert.equal(Buffer.isBuffer(key), true);
  assert.equal(key.length, 32);
  assert.equal(await fs.readFile(
    expectedPaths.key,
    'utf8',
  ), `${key.toString('hex')}\n`);
  // Windows carries owner-only intent in the SID DACL that
  // writeOwnerOnlyFileExclusive applies, not in POSIX mode bits (which Node
  // reports as 0o666 there); windows-acl.test.js covers the DACL itself.
  await assertOwnerOnlyFile(expectedPaths.key);
  assert.equal(
    await fs.stat(path.join(home, 'machine-key')).catch(() => null),
    null,
  );

  const catalog = JSON.parse(await fs.readFile(expectedPaths.catalog, 'utf8'));
  assert.deepEqual(Object.keys(catalog).sort(), [
    'domain',
    'keyId',
    'mac',
    'projects',
    'schema',
    'version',
  ]);
  assert.equal(catalog.domain, AUTH_DOMAINS.replayCatalog);
  assert.equal(catalog.schema, 'noosphere.replay-catalog');
  assert.equal(catalog.version, 1);
  assert.deepEqual(catalog.projects, []);
  assert.equal(catalog.keyId, keyModule.replayKeyId(key));
  assert.equal(
    verifyRecord(key, AUTH_DOMAINS.replayCatalog, catalog),
    true,
  );
});

test('concurrent pristine first use converges on one key and one catalog', async () => {
  assert.ok(keyModule, 'production replay key module must exist');
  const { home, env } = await environment();
  const keys = await Promise.all(
    Array.from({ length: 12 }, () => keyModule.ensureReplayKey({ env })),
  );

  assert.equal(
    new Set(keys.map(key => key.toString('hex'))).size,
    1,
  );
  assert.deepEqual(
    (await fs.readdir(paths(home).root)).sort(),
    ['catalog.json', 'machine.key'],
  );
});

test('missing key with surviving replay state fails closed without mutation', async () => {
  assert.ok(keyModule, 'production replay key module must exist');
  const { home, env } = await environment();
  const expectedPaths = paths(home);
  await fs.mkdir(path.join(expectedPaths.root, 'projects'), {
    recursive: true,
    mode: 0o700,
  });
  await fs.writeFile(
    expectedPaths.catalog,
    '{"surviving":"state"}',
    { mode: 0o600 },
  );
  const before = await fs.readFile(expectedPaths.catalog);

  await assert.rejects(
    keyModule.ensureReplayKey({ env }),
    error => error.code === 'replay-key-missing-with-state',
  );
  assert.deepEqual(await fs.readFile(expectedPaths.catalog), before);
  assert.equal(await fs.stat(expectedPaths.key).catch(() => null), null);
});

test('corrupt or replacement key never re-MACs surviving catalog state', async () => {
  assert.ok(keyModule, 'production replay key module must exist');
  for (const replacement of ['not-a-key\n', `${randomBytes(32).toString('hex')}\n`]) {
    const { home, env } = await environment();
    const expectedPaths = paths(home);
    await keyModule.ensureReplayKey({ env });
    const catalogBefore = await fs.readFile(expectedPaths.catalog);
    await fs.writeFile(expectedPaths.key, replacement);

    await assert.rejects(keyModule.ensureReplayKey({ env }));
    assert.deepEqual(await fs.readFile(expectedPaths.catalog), catalogBefore);
    assert.equal(await fs.readFile(expectedPaths.key, 'utf8'), replacement);
  }
});

test('complete replay-root deletion permits a new pristine key only', async () => {
  assert.ok(keyModule, 'production replay key module must exist');
  const { home, env } = await environment();
  const first = await keyModule.ensureReplayKey({ env });
  await fs.rm(paths(home).root, { recursive: true });
  const second = await keyModule.ensureReplayKey({ env });

  assert.notEqual(first.toString('hex'), second.toString('hex'));
  assert.deepEqual(
    (await fs.readdir(paths(home).root)).sort(),
    ['catalog.json', 'machine.key'],
  );
});

test('unsafe replay root and hard-linked key are refused', async t => {
  assert.ok(keyModule, 'production replay key module must exist');
  const symlinkCase = await environment();
  const external = await fs.mkdtemp(
    path.join(os.tmpdir(), 'noosphere-replay-external-'),
  );
  temporary.push(external);
  await fs.symlink(external, paths(symlinkCase.home).root, 'dir');
  await assert.rejects(
    keyModule.ensureReplayKey({ env: symlinkCase.env }),
    error => error.code === 'state-dir-symlink',
  );
  assert.deepEqual(await fs.readdir(external), []);

  const hardlinkCase = await environment();
  const expectedPaths = paths(hardlinkCase.home);
  await fs.mkdir(expectedPaths.root, { mode: 0o700 });
  const source = path.join(hardlinkCase.home, 'foreign-key');
  await fs.writeFile(source, `${randomBytes(32).toString('hex')}\n`, {
    mode: 0o600,
  });
  try {
    await fs.link(source, expectedPaths.key);
  } catch (error) {
    t.skip(`hard links unavailable: ${error.code}`);
    return;
  }
  await assert.rejects(
    keyModule.ensureReplayKey({ env: hardlinkCase.env }),
    error => error.code === 'state-file-hard-link',
  );
  assert.equal((await fs.stat(source)).nlink, 2);

  if (process.platform !== 'win32') {
    const unsafeHome = await environment();
    await fs.chmod(unsafeHome.home, 0o777);
    await assert.rejects(
      keyModule.ensureReplayKey({ env: unsafeHome.env }),
      error => error.code === 'state-dir-unsafe-mode',
    );
    assert.equal(
      await fs.stat(paths(unsafeHome.home).root).catch(() => null),
      null,
    );
  }
});

test('module exposes no replay-key mutation or recovery operation', () => {
  assert.ok(keyModule, 'production replay key module must exist');
  assert.deepEqual(Object.keys(keyModule).sort(), [
    'ensureReplayKey',
    'loadReplayKey',
    'replayKeyId',
    'replayKeyPath',
    'replayRootPath',
  ]);
  for (const forbidden of [
    'reset',
    'reinitialize',
    'rotate',
    'repair',
    'recover',
    'import',
    'export',
  ]) {
    assert.equal(
      Object.keys(keyModule).some(name =>
        name.toLowerCase().includes(forbidden)),
      false,
      forbidden,
    );
  }
});
