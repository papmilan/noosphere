import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import {
  PathBoundaryError,
  atomicOwnerOnlyWrite,
  atomicOwnerOnlyWriteSync,
  currentWindowsSid,
  readOwnerOnlyFile,
  readOwnerOnlyFileSync,
  verifyOwnerOnlyWindows,
  writeOwnerOnlyFileExclusive,
} from '../index.js';

function temporaryDirectory(prefix = 'secure-persistence-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function simulatedWindowsAction(events, { failWrite = false, failRead = false } = {}) {
  return ({ action, file, input }) => {
    events.push(action);
    if (action === 'write') {
      assert.equal(fs.existsSync(file), false, 'the Windows helper exclusively creates the temp itself');
      const fd = fs.openSync(file, 'wx', 0o600);
      try {
        events.push(`size-before-acl:${fs.fstatSync(fd).size}`);
        events.push('acl-verified');
        if (failWrite) throw new PathBoundaryError('state-acl-failed', 'forced ACL failure');
        fs.writeFileSync(fd, input);
      } finally {
        fs.closeSync(fd);
      }
      return Buffer.alloc(0);
    }
    if (action === 'read') {
      events.push('acl-verified');
      if (failRead) throw new PathBoundaryError('state-acl-broad', 'forced repair failure');
      return fs.readFileSync(file);
    }
    throw new Error(`unexpected action ${action}`);
  };
}

describe('shared owner-only persistence boundary', () => {
  test('Windows writes verify an empty file before any sensitive byte and then atomically replace', async () => {
    const dir = temporaryDirectory();
    const target = path.join(dir, 'state.json');
    const events = [];

    await atomicOwnerOnlyWrite(target, Buffer.from('sensitive'), {
      root: dir,
      platform: 'win32',
      windowsAction: simulatedWindowsAction(events),
    });

    assert.equal(fs.readFileSync(target, 'utf8'), 'sensitive');
    assert.deepEqual(events, ['write', 'size-before-acl:0', 'acl-verified']);
    assert.deepEqual(fs.readdirSync(dir), ['state.json']);
  });

  test('Windows ACL failure removes the empty temporary file and preserves the prior target', async () => {
    const dir = temporaryDirectory();
    const target = path.join(dir, 'state.json');
    fs.writeFileSync(target, 'previous');

    await assert.rejects(
      atomicOwnerOnlyWrite(target, Buffer.from('new-secret'), {
        root: dir,
        platform: 'win32',
        windowsAction: simulatedWindowsAction([], { failWrite: true }),
      }),
      (error) => error.code === 'state-acl-failed',
    );

    assert.equal(fs.readFileSync(target, 'utf8'), 'previous');
    assert.deepEqual(fs.readdirSync(dir), ['state.json']);
  });

  test('Windows legacy repair completes before content is returned and fails closed', async () => {
    const dir = temporaryDirectory();
    const target = path.join(dir, 'legacy.json');
    fs.writeFileSync(target, 'legacy-secret');
    const events = [];

    const repaired = await readOwnerOnlyFile(target, {
      root: dir,
      platform: 'win32',
      windowsAction: simulatedWindowsAction(events),
    });
    assert.equal(repaired.toString(), 'legacy-secret');
    assert.deepEqual(events, ['read', 'acl-verified']);

    await assert.rejects(
      readOwnerOnlyFile(target, {
        root: dir,
        platform: 'win32',
        windowsAction: simulatedWindowsAction([], { failRead: true }),
      }),
      (error) => error.code === 'state-acl-broad',
    );
  });

  test('sync Windows write and read use the same boundary and cleanup semantics', () => {
    const dir = temporaryDirectory();
    const target = path.join(dir, 'credentials.json');
    const events = [];
    const options = {
      root: dir,
      platform: 'win32',
      windowsAction: simulatedWindowsAction(events),
    };

    atomicOwnerOnlyWriteSync(target, 'credential', options);
    assert.equal(readOwnerOnlyFileSync(target, options).toString(), 'credential');
    assert.deepEqual(events, [
      'write', 'size-before-acl:0', 'acl-verified',
      'read', 'acl-verified',
    ]);
  });

  test('POSIX writes remain exclusive, owner-only, atomic, and no-follow', {
    skip: process.platform === 'win32' ? 'POSIX mode and O_NOFOLLOW semantics' : false,
  }, async () => {
    const dir = temporaryDirectory();
    const target = path.join(dir, 'state.json');
    await atomicOwnerOnlyWrite(target, 'value', { root: dir, platform: 'linux' });
    assert.equal(fs.readFileSync(target, 'utf8'), 'value');
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);

    const outside = path.join(dir, 'outside');
    fs.writeFileSync(outside, 'outside');
    fs.rmSync(target);
    fs.symlinkSync(outside, target);
    await assert.rejects(
      atomicOwnerOnlyWrite(target, 'replacement', { root: dir, platform: 'linux' }),
      (error) => error.code === 'state-file-symlink',
    );
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
  });

  test('exclusive staging writes secure content without renaming it', async () => {
    const dir = temporaryDirectory();
    const staged = path.join(dir, '.transaction-json.new');
    const events = [];
    await writeOwnerOnlyFileExclusive(staged, 'staged-secret', {
      root: dir,
      platform: 'win32',
      windowsAction: simulatedWindowsAction(events),
    });
    assert.equal(fs.readFileSync(staged, 'utf8'), 'staged-secret');
    assert.deepEqual(events, ['write', 'size-before-acl:0', 'acl-verified']);
  });

  test('SID resolution and DACL parsing fail closed without identity fallbacks', () => {
    const dir = temporaryDirectory();
    const target = path.join(dir, 'state.json');
    fs.writeFileSync(target, 'state');

    assert.throws(
      () => currentWindowsSid({ platform: 'win32', windowsAction: () => Buffer.from('DOMAIN\\friendly-name') }),
      (error) => error.code === 'state-acl-sid-failed',
    );
    assert.throws(
      () => currentWindowsSid({
        platform: 'win32',
        windowsAction: () => { throw new PathBoundaryError('state-acl-sid-failed', 'token unavailable'); },
      }),
      (error) => error.code === 'state-acl-sid-failed',
    );
    assert.throws(
      () => verifyOwnerOnlyWindows(target, {
        platform: 'win32',
        windowsAction: () => Buffer.from('S-1-5-21-1\nS-1-5-18\nS-1-5-32-544\nS-1-5-4'),
      }),
      (error) => error.code === 'state-acl-readback-failed',
    );
    assert.deepEqual(
      verifyOwnerOnlyWindows(target, {
        platform: 'win32',
        windowsAction: () => Buffer.from('S-1-5-32-544\nS-1-5-18\nS-1-5-18'),
      }),
      ['S-1-5-18', 'S-1-5-32-544'],
    );
  });

  test('all Windows boundary failure classes preserve the old target and remove staging files', async () => {
    const codes = [
      'state-acl-failed',
      'state-acl-mutation-failed',
      'state-acl-readback-failed',
      'state-acl-broad',
      'state-write-incomplete',
    ];
    for (const code of codes) {
      const dir = temporaryDirectory(`secure-${code}-`);
      const target = path.join(dir, 'state.json');
      fs.writeFileSync(target, 'previous');
      await assert.rejects(
        atomicOwnerOnlyWrite(target, 'new-secret', {
          root: dir,
          platform: 'win32',
          windowsAction: ({ file }) => {
            fs.closeSync(fs.openSync(file, 'wx', 0o600));
            throw new PathBoundaryError(code, 'forced security failure');
          },
        }),
        (error) => error.code === code,
      );
      assert.equal(fs.readFileSync(target, 'utf8'), 'previous');
      assert.deepEqual(fs.readdirSync(dir), ['state.json']);
    }
  });

  test('rename failure preserves the old target and removes the secured temporary file', async () => {
    const dir = temporaryDirectory();
    const target = path.join(dir, 'state.json');
    fs.writeFileSync(target, 'previous');
    await assert.rejects(
      atomicOwnerOnlyWrite(target, 'new-secret', {
        root: dir,
        platform: 'win32',
        windowsAction: simulatedWindowsAction([]),
        rename: async () => { throw Object.assign(new Error('forced rename failure'), { code: 'EIO' }); },
      }),
      (error) => error.code === 'EIO',
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'previous');
    assert.deepEqual(fs.readdirSync(dir), ['state.json']);
  });
});
