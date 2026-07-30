import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import {
  PathBoundaryError,
  acquireOwnerOnlyLock,
  atomicOwnerOnlyWrite,
  isIgnorableDirFsyncError,
  atomicOwnerOnlyWriteSync,
  currentWindowsSid,
  readOwnerOnlyFile,
  readOwnerOnlyFileSync,
  verifyNoForeignWriteWindows,
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

  // SEC-05 Phase 4C Finding 4. A restore destination is a repository file: it
  // inherits the repository ACL, and the question is the POSIX one — can anyone
  // but the owner modify it?
  test('Windows destination check mirrors the POSIX write check, not owner-only', () => {
    const dir = temporaryDirectory();
    const target = path.join(dir, 'baseline.md');
    fs.writeFileSync(target, 'repository content');
    const OWNER = 'S-1-5-21-1-2-3-1001';
    const check = (lines) => verifyNoForeignWriteWindows(target, {
      platform: 'win32',
      windowsAction: () => Buffer.from(lines.join('\n')),
    });

    // The shape a real repository file has: inherited ACEs, owner plus the two
    // privileged built-ins holding write. This is what owner-only refused.
    assert.deepEqual(
      check([`owner:${OWNER}`, `write:${OWNER}`, 'write:S-1-5-18', 'write:S-1-5-32-544']),
      ['S-1-5-18', OWNER, 'S-1-5-32-544'],
    );
    // Nobody at all holding write is trivially fine.
    assert.deepEqual(check([`owner:${OWNER}`]), []);
    // A foreign principal with READ ONLY never appears in the write list, so a
    // world-readable repository file passes — exactly as 0644 does on POSIX.
    assert.deepEqual(check([`owner:${OWNER}`, `write:${OWNER}`]), [OWNER]);

    // …and a foreign principal WITH write is refused, which is the whole point.
    for (const foreign of ['S-1-5-32-545', 'S-1-1-0', 'S-1-5-11', 'S-1-5-21-9-9-9-1002']) {
      assert.throws(
        () => check([`owner:${OWNER}`, `write:${OWNER}`, `write:${foreign}`]),
        (error) => error.code === 'state-destination-foreign-write' &&
          error.message.includes(foreign),
        `${foreign} must not be allowed to write the destination`,
      );
    }
  });

  test('Windows destination check fails closed on an unreadable ACL answer', () => {
    const dir = temporaryDirectory();
    const target = path.join(dir, 'baseline.md');
    fs.writeFileSync(target, 'repository content');
    const check = (text) => verifyNoForeignWriteWindows(target, {
      platform: 'win32',
      windowsAction: () => Buffer.from(text),
    });

    // An unparseable answer is an unanswered question, never "no foreign writer".
    for (const bad of [
      '',
      'S-1-5-18',                                  // unprefixed, the old format
      'owner:DOMAIN\\friendly-name',
      'owner:S-1-5-21-1\nwrite:not-a-sid',
      'write:S-1-5-18',                            // no owner line
      'owner:S-1-5-21-1\nowner:S-1-5-21-2',        // two owners
      'garbage',
    ]) {
      assert.throws(
        () => check(bad),
        (error) => error.code === 'state-acl-readback-failed',
        `must fail closed on: ${JSON.stringify(bad)}`,
      );
    }
    // A non-Windows platform never spawns the helper at all.
    assert.deepEqual(
      verifyNoForeignWriteWindows(target, {
        platform: 'linux',
        windowsAction: () => { throw new Error('must not run off Windows'); },
      }),
      [],
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

describe('SEC-05 Phase 4A-R1 — owner-only transaction lock', () => {
  const UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  test('rejects a non-UUID token (loose hyphen count)', async () => {
    const dir = temporaryDirectory('secure-lock-');
    const file = path.join(dir, 'slot.lock');
    for (const token of ['-'.repeat(36), 'g'.repeat(36), 'aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa', 'short']) {
      await assert.rejects(acquireOwnerOnlyLock(file, { token, root: dir }), (e) => e.code === 'state-lock-token-invalid');
    }
    assert.equal(fs.existsSync(file), false);
  });

  test('acquires exclusively and blocks a second holder', async () => {
    const dir = temporaryDirectory('secure-lock-');
    const file = path.join(dir, 'slot.lock');
    const lock = await acquireOwnerOnlyLock(file, { token: UUID, root: dir });
    await assert.rejects(acquireOwnerOnlyLock(file, { token: UUID, root: dir }), (e) => e.code === 'trust-lock-busy');
    await lock.release();
    assert.equal(fs.existsSync(file), false);
  });

  test('release verifies the owner token in constant time', async () => {
    const dir = temporaryDirectory('secure-lock-');
    const file = path.join(dir, 'slot.lock');
    const lock = await acquireOwnerOnlyLock(file, { token: UUID, root: dir });
    await assert.rejects(lock.release('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), (e) => e.code === 'trust-lock-not-owner');
    assert.equal(fs.existsSync(file), true);
    await lock.release();
    assert.equal(fs.existsSync(file), false);
  });
});

describe('SEC-05 Phase 4A-R2 — directory fsync durability classification', () => {
  test('ignores only genuine unsupported-operation errno, surfaces meaningful ones', () => {
    for (const code of ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP']) {
      assert.equal(isIgnorableDirFsyncError({ code }), true, `${code} must be ignorable`);
    }
    for (const code of ['EIO', 'ENOSPC', 'EACCES', 'EBADF', 'EROFS', undefined]) {
      assert.equal(isIgnorableDirFsyncError({ code }), false, `${code} must be surfaced`);
    }
    assert.equal(isIgnorableDirFsyncError(null), false);
  });
});
