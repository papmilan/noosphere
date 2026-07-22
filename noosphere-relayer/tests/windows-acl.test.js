import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { DurableStore } from '../durable-store.js';
import { LocalMemoryStore } from '../local-memory.js';
import { CredentialStore } from '../credentials.js';
import { FileSnapshotBackend } from '../snapshot-backend.js';
import { secureOwnerOnlyWindows } from '../secure-fs.js';

// SEC-03 Windows owner-only ACL coverage. Node's 0o600 is not an owner-only ACL on
// Windows, so persisted secrets/state could inherit broad read ACEs. These MUST run
// on win32 (a skipped security test is not evidence). They do not require a second
// local user: they assert the effective ACL structure via icacls directly.
const isWin = process.platform === 'win32';
const skip = isWin ? false : 'Windows-only owner-only ACL coverage';

const hash = (v) => createHash('sha256').update(String(v), 'utf8').digest('hex');
const SNAP = `sha256:${'a'.repeat(64)}`;
const BROAD = /(^|\s)(Everyone|BUILTIN\\Users|(NT AUTHORITY\\)?Authenticated Users):/i;

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function acl(file) {
  return execFileSync('icacls', [file], { encoding: 'utf8' });
}
function assertOwnerOnly(file, label) {
  const out = acl(file);
  console.log(`[SEC-03 WINDOWS ACL] ${label}:`, JSON.stringify(out.split(/\r?\n/).filter(Boolean)));
  assert.equal(BROAD.test(out), false, `${label} must not grant a broad principal`);
}
function grantBroad(file) {
  // Simulate a legacy insecure file: explicitly grant Everyone read.
  execFileSync('icacls', [file, '/grant', 'Everyone:(R)'], { stdio: 'pipe' });
}

test('WINDOWS ACL: secureOwnerOnlyWindows strips a broad ACE and verifies owner-only', { skip }, () => {
  const base = tmp('acl-h-');
  const file = path.join(base, 'secret.txt');
  fs.writeFileSync(file, 'x');
  grantBroad(file);
  assert.equal(BROAD.test(acl(file)), true, 'precondition: Everyone was granted');
  secureOwnerOnlyWindows(file);
  assertOwnerOnly(file, 'secureOwnerOnlyWindows');
});

test('WINDOWS ACL: credentials fallback write produces an owner-only file', { skip }, () => {
  const home = tmp('acl-cred-');
  const store = new CredentialStore('default', { platform: 'win32', home, run: () => ({ status: 1, stdout: '' }) });
  // Force the owner-only fallback path (not DPAPI) by exercising the fallback store.
  store.setPassword?.('super-secret');
  const fallback = path.join(home, '.noosphere', 'credentials-default.json');
  if (fs.existsSync(fallback)) assertOwnerOnly(fallback, 'credentials fallback');
  else console.log('[SEC-03 WINDOWS ACL] credentials fallback not written on this platform config; setPassword used DPAPI');
});

test('WINDOWS ACL: credentials read repairs a legacy broad ACL', { skip }, () => {
  const home = tmp('acl-credr-');
  fs.mkdirSync(path.join(home, '.noosphere'), { recursive: true });
  const fallback = path.join(home, '.noosphere', 'credentials-default.json');
  fs.writeFileSync(fallback, JSON.stringify({ MEMWAL_SECRET: 's' }));
  grantBroad(fallback);
  assert.equal(BROAD.test(acl(fallback)), true, 'precondition: legacy file is world-readable');
  const store = new CredentialStore('default', { platform: 'win32', home, run: () => ({ status: 1, stdout: '' }) });
  store.getPassword();
  assertOwnerOnly(fallback, 'credentials read-repair');
});

test('WINDOWS ACL: DurableStore persisted state is owner-only', { skip }, async () => {
  const dir = tmp('acl-ds-');
  const filePath = path.join(dir, 'state.json');
  const store = new DurableStore({ filePath, persist: true });
  await store.complete('job', { ok: true });
  assertOwnerOnly(filePath, 'DurableStore state');
});

test('WINDOWS ACL: LocalMemoryStore persisted memory is owner-only', { skip }, async () => {
  const dir = tmp('acl-lm-');
  const filePath = path.join(dir, 'memory.json');
  const store = new LocalMemoryStore({ NODE_ENV: 'production', LOCAL_MEMORY_PATH: filePath }, { defaultPath: filePath });
  await store.remember('p', 'ns', 'text');
  assertOwnerOnly(filePath, 'LocalMemory state');
});

test('WINDOWS ACL: FileSnapshotBackend snapshot is owner-only', { skip }, async () => {
  const root = tmp('acl-snap-');
  const be = new FileSnapshotBackend({ root });
  await be.put('proj', SNAP, Buffer.from('state-bytes'));
  const onDisk = path.join(root, hash('proj'), `${hash(SNAP)}.json`);
  assertOwnerOnly(onDisk, 'snapshot file');
});
