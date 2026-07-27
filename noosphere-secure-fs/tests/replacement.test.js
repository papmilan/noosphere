import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  commitOwnerOnlyReplacement,
  discardOwnerOnlyReplacement,
  prepareOwnerOnlyReplacement,
} from '../index.js';

const temporary = [];

after(async () => {
  await Promise.all(temporary.map(directory =>
    fs.rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'secure-replacement-'));
  temporary.push(root);
  const directory = path.join(root, '.noosphere');
  await fs.mkdir(directory, { mode: 0o700 });
  return {
    destination: path.join(directory, 'baseline.md'),
    root,
  };
}

describe('two-phase owner-only replacement', () => {
  it('durably prepares a sibling before atomically creating an absent destination', async () => {
    const context = await fixture();
    const prepared = await prepareOwnerOnlyReplacement(
      context.destination,
      Buffer.from('replacement bytes'),
      { root: context.root },
    );
    await assert.rejects(fs.access(context.destination));
    assert.equal((await fs.stat(prepared.temporaryPath)).mode & 0o777, 0o600);

    await commitOwnerOnlyReplacement(prepared, { root: context.root });

    assert.equal(await fs.readFile(context.destination, 'utf8'), 'replacement bytes');
    await assert.rejects(fs.access(prepared.temporaryPath));
  });

  it('refuses a destination race and preserves the externally changed file', async () => {
    const context = await fixture();
    await fs.writeFile(context.destination, 'observed');
    const prepared = await prepareOwnerOnlyReplacement(
      context.destination,
      Buffer.from('proposed'),
      { root: context.root },
    );
    await fs.writeFile(context.destination, 'raced');

    await assert.rejects(
      commitOwnerOnlyReplacement(prepared, { root: context.root }),
      error => error.code === 'state-destination-changed',
    );
    assert.equal(await fs.readFile(context.destination, 'utf8'), 'raced');
    assert.equal(await discardOwnerOnlyReplacement(prepared, {
      root: context.root,
    }), true);
  });

  it('rejects symlink, hard-link, and unsafe-mode destinations', async () => {
    const target = await fixture();
    const real = path.join(target.root, 'real');
    await fs.writeFile(real, 'real');
    await fs.symlink(real, target.destination);
    await assert.rejects(
      prepareOwnerOnlyReplacement(target.destination, 'x', {
        root: target.root,
      }),
      error => error.code === 'state-file-symlink',
    );

    const linked = await fixture();
    const peer = path.join(linked.root, 'peer');
    await fs.writeFile(peer, 'linked');
    await fs.link(peer, linked.destination);
    await assert.rejects(
      prepareOwnerOnlyReplacement(linked.destination, 'x', {
        root: linked.root,
      }),
      error => error.code === 'state-file-hard-link',
    );

    if (process.platform !== 'win32') {
      const writable = await fixture();
      await fs.writeFile(writable.destination, 'unsafe', { mode: 0o666 });
      await fs.chmod(writable.destination, 0o666);
      await assert.rejects(
        prepareOwnerOnlyReplacement(writable.destination, 'x', {
          root: writable.root,
        }),
        error => error.code === 'state-file-unsafe-mode',
      );
    }
  });

  it('rejects a symlinked ancestor and non-regular destination', async () => {
    const ancestor = await fixture();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'secure-replacement-outside-'));
    temporary.push(outside);
    const linkedDirectory = path.join(ancestor.root, 'linked');
    await fs.symlink(outside, linkedDirectory);
    await assert.rejects(
      prepareOwnerOnlyReplacement(
        path.join(linkedDirectory, 'destination'),
        'x',
        { root: ancestor.root },
      ),
      error => error.code === 'state-dir-symlink',
    );

    const directory = await fixture();
    await fs.mkdir(directory.destination);
    await assert.rejects(
      prepareOwnerOnlyReplacement(directory.destination, 'x', {
        root: directory.root,
      }),
      error => error.code === 'state-file-not-regular',
    );

    if (process.platform !== 'win32') {
      const unsafeParent = await fixture();
      await fs.chmod(path.dirname(unsafeParent.destination), 0o777);
      await assert.rejects(
        prepareOwnerOnlyReplacement(unsafeParent.destination, 'x', {
          root: unsafeParent.root,
        }),
        error => error.code === 'state-dir-unsafe-mode',
      );
    }
  });

  it('regenerates a fresh temporary name after an exclusive collision', async () => {
    const context = await fixture();
    const first = '11111111-1111-4111-8111-111111111111';
    const second = '22222222-2222-4222-8222-222222222222';
    const collision = path.join(
      path.dirname(context.destination),
      `.${path.basename(context.destination)}.${first}.restore-tmp`,
    );
    await fs.writeFile(collision, 'occupied', { mode: 0o600 });
    let calls = 0;
    const prepared = await prepareOwnerOnlyReplacement(
      context.destination,
      'replacement',
      {
        root: context.root,
        randomUUID: () => {
          calls += 1;
          return calls === 1 ? first : second;
        },
      },
    );
    assert.equal(calls, 2);
    assert.match(prepared.temporaryPath, new RegExp(`${second}\\.restore-tmp$`));
    assert.equal(await fs.readFile(collision, 'utf8'), 'occupied');
    await discardOwnerOnlyReplacement(prepared, { root: context.root });
  });

  it('detects an incomplete temporary write and cleans it', async () => {
    const context = await fixture();
    await assert.rejects(
      prepareOwnerOnlyReplacement(
        context.destination,
        Buffer.from('complete bytes'),
        {
          root: context.root,
          writeExclusive: async (file, bytes) => {
            await fs.writeFile(file, bytes.subarray(0, 3), {
              flag: 'wx',
              mode: 0o600,
            });
          },
        },
      ),
      error => error.code === 'state-write-incomplete',
    );
    assert.deepEqual(
      (await fs.readdir(path.dirname(context.destination))).filter(name =>
        name.endsWith('.restore-tmp')),
      [],
    );
  });

  it('fails closed when simulated Windows DACL verification is unsafe', async () => {
    const context = await fixture();
    await fs.writeFile(context.destination, 'windows destination');
    await assert.rejects(
      prepareOwnerOnlyReplacement(context.destination, 'replacement', {
        root: context.root,
        platform: 'win32',
        windowsAction: ({ action }) => {
          if (action === 'verify') return Buffer.from('S-1-5-18\n');
          throw new Error(`unexpected Windows action: ${action}`);
        },
      }),
      error => error.code === 'state-acl-readback-failed',
    );
  });

  it('preserves the destination on rename failure and reports post-rename fsync failure', async () => {
    const renameFailure = await fixture();
    await fs.writeFile(renameFailure.destination, 'original');
    const prepared = await prepareOwnerOnlyReplacement(
      renameFailure.destination,
      'replacement',
      { root: renameFailure.root },
    );
    await assert.rejects(
      commitOwnerOnlyReplacement(prepared, {
        root: renameFailure.root,
        rename: async () => {
          const error = new Error('rename failed');
          error.code = 'EIO';
          throw error;
        },
      }),
      error => error.code === 'EIO',
    );
    assert.equal(await fs.readFile(renameFailure.destination, 'utf8'), 'original');
    await discardOwnerOnlyReplacement(prepared, { root: renameFailure.root });

    if (process.platform !== 'win32') {
      const fsyncFailure = await fixture();
      const fsyncPrepared = await prepareOwnerOnlyReplacement(
        fsyncFailure.destination,
        'committed before fsync error',
        { root: fsyncFailure.root },
      );
      await assert.rejects(
        commitOwnerOnlyReplacement(fsyncPrepared, {
          root: fsyncFailure.root,
          fsyncDirectory: async () => {
            const error = new Error('fsync failed');
            error.code = 'EIO';
            throw error;
          },
        }),
        error => error.code === 'state-directory-fsync-failed-after-replace' &&
          error.destinationReplaced === true,
      );
      assert.equal(
        await fs.readFile(fsyncFailure.destination, 'utf8'),
        'committed before fsync error',
      );
    }
  });
});
