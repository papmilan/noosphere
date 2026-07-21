import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { FileSnapshotBackend } from '../snapshot-backend.js';

const hash = (v) => createHash('sha256').update(String(v), 'utf8').digest('hex');
const SNAP = `sha256:${'a'.repeat(64)}`;

function roots() {
  return {
    root: fs.mkdtempSync(path.join(os.tmpdir(), 'snap-root-')),
    outside: fs.mkdtempSync(path.join(os.tmpdir(), 'snap-outside-')),
  };
}

test('normal snapshot put/get round-trips inside the root', async () => {
  const { root } = roots();
  const be = new FileSnapshotBackend({ root });
  await be.put('proj', SNAP, Buffer.from('state-bytes'));
  const got = await be.get('proj', SNAP);
  assert.equal(got.toString(), 'state-bytes');
  // The file lives under the hashed project dir inside root.
  const onDisk = path.join(root, hash('proj'), `${hash(SNAP)}.json`);
  assert.equal(fs.existsSync(onDisk), true);
});

test('SEC-03 REGRESSION: a symlinked per-project component cannot redirect a write outside the root', async () => {
  const { root, outside } = roots();
  // Attacker pre-plants the (publicly derivable) hashed project dir as a symlink.
  fs.symlinkSync(outside, path.join(root, hash('victim-project')), 'dir');
  const be = new FileSnapshotBackend({ root });

  await assert.rejects(
    () => be.put('victim-project', SNAP, Buffer.from('SECRET STATE')),
    (e) => e.code === 'state-dir-symlink',
  );
  // Prove the OUTSIDE side effect did not happen: nothing was written there.
  assert.deepEqual(fs.readdirSync(outside), [], 'no file may be created outside the root');
  assert.equal(fs.existsSync(path.join(outside, `${hash(SNAP)}.json`)), false);
});

test('SEC-03 REGRESSION: a symlinked snapshot FILE is not followed on read', async () => {
  const { root, outside } = roots();
  // Legitimate project dir, but the final snapshot file is a symlink to an
  // outside secret. A no-follow read must refuse rather than disclose it.
  const dir = path.join(root, hash('proj'));
  fs.mkdirSync(dir, { recursive: true });
  const secret = path.join(outside, 'secret.txt');
  fs.writeFileSync(secret, 'OUTSIDE SECRET');
  fs.symlinkSync(secret, path.join(dir, `${hash(SNAP)}.json`), 'file');

  const be = new FileSnapshotBackend({ root });
  await assert.rejects(
    () => be.get('proj', SNAP),
    (e) => e.code === 'snapshot-path-symlink',
  );
});

test('SEC-03 REGRESSION: put refuses to overwrite through a symlinked file', async () => {
  const { root, outside } = roots();
  const dir = path.join(root, hash('proj'));
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(outside, 'target.json');
  fs.writeFileSync(target, 'ORIGINAL');
  fs.symlinkSync(target, path.join(dir, `${hash(SNAP)}.json`), 'file');

  const be = new FileSnapshotBackend({ root });
  await assert.rejects(
    () => be.put('proj', SNAP, Buffer.from('OVERWRITE')),
    (e) => e.code === 'snapshot-path-symlink',
  );
  assert.equal(fs.readFileSync(target, 'utf8'), 'ORIGINAL', 'outside file must be untouched');
});
