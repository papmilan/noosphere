import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { DurableStore } from '../durable-store.js';
import { LocalMemoryStore } from '../local-memory.js';
import { CredentialStore } from '../credentials.js';
import { FileSnapshotBackend } from '../snapshot-backend.js';
import { readContainedStateFile, ensureRealDirectoryPath } from '../secure-fs.js';

// SEC-03 Windows junction / reparse-point coverage. These MUST run on win32 (a
// skipped security test is not evidence). Directory junctions need no privilege, so
// junction cases are mandatory on Windows; file-symlink creation needs
// SeCreateSymbolicLink, so those cases are gated on an explicit privilege probe and
// the environment shortfall is RECORDED, never silently converted to a pass.
const isWin = process.platform === 'win32';
const skip = isWin ? false : 'Windows-only; POSIX equivalents covered by secure-fs / state-load / snapshot tests';

const hash = (v) => createHash('sha256').update(String(v), 'utf8').digest('hex');
const SNAP = `sha256:${'a'.repeat(64)}`;

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Try to create a file symlink; returns true if the environment permits it.
function fileSymlinkSupported() {
  const base = tmp('winsym-probe-');
  const target = path.join(base, 'target');
  fs.writeFileSync(target, 'x');
  try {
    fs.symlinkSync(target, path.join(base, 'link'), 'file');
    return true;
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return false;
    throw error;
  }
}

function plantSentinel(outside) {
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'KEEP.txt'), 'inert-sentinel');
}
function assertSentinelOnly(outside) {
  assert.deepEqual(fs.readdirSync(outside).sort(), ['KEEP.txt'], 'nothing may be created in the junction target');
  assert.equal(fs.readFileSync(path.join(outside, 'KEEP.txt'), 'utf8'), 'inert-sentinel', 'sentinel must be unchanged');
}

// ---- Phase 1 behavior probe: record how Windows surfaces a junction. ----
test('WINDOWS PROBE: directory junction is classified as a symlink and realpath reveals the target', { skip }, () => {
  const base = tmp('winprobe-');
  const outside = tmp('winprobe-out-');
  fs.mkdirSync(outside, { recursive: true });
  const j = path.join(base, 'junction');
  fs.symlinkSync(outside, j, 'junction');

  const l = fs.lstatSync(j);
  const observations = {
    O_NOFOLLOW: fs.constants.O_NOFOLLOW ?? 0,
    junction_isSymbolicLink: l.isSymbolicLink(),
    junction_isDirectory: l.isDirectory(),
    realpath_reveals_target: fs.realpathSync(j) === fs.realpathSync(outside),
  };
  console.log('[SEC-03 WINDOWS PROBE]', JSON.stringify(observations));
  // Security-critical facts the boundary relies on:
  assert.equal(observations.junction_isSymbolicLink, true, 'lstat must classify a junction as a symlink');
  assert.equal(observations.realpath_reveals_target, true, 'realpath must reveal the junction destination');
});

// ---- Phase 2/3 reproduction: ancestor junction must not redirect state I/O. ----
test('WINDOWS: DurableStore read+write refuse an ancestor junction (target untouched)', { skip }, async () => {
  const base = tmp('winds-');
  const outside = path.join(base, 'outside');
  const intended = path.join(base, 'intended');
  fs.mkdirSync(intended, { recursive: true });
  plantSentinel(outside);
  fs.symlinkSync(outside, path.join(intended, 'linked'), 'junction');
  const filePath = path.join(intended, 'linked', 'inner', 'state.json');

  await assert.rejects(() => ensureRealDirectoryPath(path.dirname(filePath)), (e) => e.code === 'state-dir-symlink');
  await assert.rejects(() => readContainedStateFile(filePath), (e) => e.code === 'state-dir-symlink');
  const store = new DurableStore({ filePath, persist: true });
  await assert.rejects(() => store.initialize(), (e) => e.code === 'state-dir-symlink');
  assertSentinelOnly(outside);
});

test('WINDOWS: LocalMemory read refuses an ancestor junction (target untouched)', { skip }, async () => {
  const base = tmp('winlm-');
  const outside = path.join(base, 'outside');
  const intended = path.join(base, 'intended');
  fs.mkdirSync(intended, { recursive: true });
  plantSentinel(outside);
  fs.symlinkSync(outside, path.join(intended, 'linked'), 'junction');
  const filePath = path.join(intended, 'linked', 'inner', 'memory.json');
  const store = new LocalMemoryStore({ NODE_ENV: 'production', LOCAL_MEMORY_PATH: filePath }, { defaultPath: filePath });
  await assert.rejects(() => store.recall('p', 10), (e) => e.code === 'state-dir-symlink');
  assertSentinelOnly(outside);
});

test('WINDOWS: FileSnapshotBackend get+put refuse a per-project junction (target untouched)', { skip }, async () => {
  const root = tmp('winsnap-');
  const outside = tmp('winsnap-out-');
  plantSentinel(outside);
  // Attacker pre-plants the (publicly derivable) hashed project dir as a junction.
  fs.symlinkSync(outside, path.join(root, hash('victim')), 'junction');
  const be = new FileSnapshotBackend({ root });
  await assert.rejects(() => be.put('victim', SNAP, Buffer.from('SECRET')), (e) => e.code === 'state-dir-symlink');
  await assert.rejects(() => be.get('victim', SNAP), (e) => e.code === 'state-dir-symlink');
  assertSentinelOnly(outside);
});

// ---- Final-component file symlink: gated on symlink privilege, shortfall recorded. ----
test('WINDOWS: final-component file symlink is refused on read (or records missing privilege)', { skip }, async () => {
  if (!fileSymlinkSupported()) {
    console.log('[SEC-03 WINDOWS] file-symlink creation unavailable (no SeCreateSymbolicLink privilege); junction coverage stands, final-file-symlink case not exercised here');
    return; // NOT a security pass — an environment capability gap, explicitly logged.
  }
  const root = tmp('winfile-');
  const outside = tmp('winfile-out-');
  const secret = path.join(outside, 'secret.json');
  fs.writeFileSync(secret, '{"version":1,"receipts":{"STOLEN":{"completedAt":1}},"pending":{},"exact_state":{"version":1,"projects":{}}}');
  const dir = path.join(root, 'd');
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(secret, path.join(dir, 'state.json'), 'file');
  const filePath = path.join(dir, 'state.json');

  await assert.rejects(() => readContainedStateFile(filePath), (e) => e.code === 'state-file-symlink');
  const store = new DurableStore({ filePath, persist: true });
  await assert.rejects(() => store.initialize(), (e) => e.code === 'state-file-symlink');
  assert.equal(Object.keys(store.state.receipts).length, 0, 'no outside receipt ingested');
});

test('WINDOWS: credentials fallback read refuses a junctioned ancestor (no secret disclosed)', { skip }, () => {
  const home = tmp('wincred-');
  const outside = tmp('wincred-out-');
  fs.mkdirSync(path.join(outside, '.noosphere'), { recursive: true });
  fs.writeFileSync(path.join(outside, '.noosphere', 'credentials-default.json'), 'SECRET-OUTSIDE');
  fs.symlinkSync(path.join(outside, '.noosphere'), path.join(home, '.noosphere'), 'junction');
  const store = new CredentialStore('default', { platform: 'win32', home, run: () => ({ status: 1, stdout: '' }) });
  const value = store.getPassword();
  assert.notEqual(value, 'SECRET-OUTSIDE', 'outside credential must never be returned');
  assert.equal(fs.readFileSync(path.join(outside, '.noosphere', 'credentials-default.json'), 'utf8'), 'SECRET-OUTSIDE', 'outside file untouched');
});
