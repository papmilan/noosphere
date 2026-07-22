import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DurableStore } from '../durable-store.js';
import { LocalMemoryStore } from '../local-memory.js';
import { CredentialStore } from '../credentials.js';
import { ensureRealDirectoryPath, readContainedStateFile } from '../secure-fs.js';

// SEC-03 increment 2: the state-index load reads (DurableStore.load,
// LocalMemoryStore.load) previously used a follow-prone readFile with no
// directory validation, so a pre-planted symlink at the configured state path
// redirected the read to an OUTSIDE file (verified: contents were ingested as
// authoritative state). These tests prove the load path now fails closed and
// never discloses outside-root bytes, while legitimate state still loads.

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('DurableStore.load: legitimate state loads correctly', async () => {
  const dir = tmp('ds-ok-');
  const filePath = path.join(dir, 'state.json');
  const seed = new DurableStore({ filePath, persist: true });
  await seed.complete('job-1', { ok: true });

  const reopened = new DurableStore({ filePath, persist: true });
  assert.deepEqual(await reopened.getReceipt('job-1'), { ok: true });
});

test('DurableStore.load: symlinked state FILE fails closed, no outside read', async () => {
  const root = tmp('ds-root-');
  const outside = tmp('ds-outside-');
  const secret = path.join(outside, 'secret.json');
  fs.writeFileSync(
    secret,
    JSON.stringify({
      version: 1,
      receipts: { STOLEN: { completedAt: Date.now() } },
      pending: {},
      exact_state: { version: 1, relayer_index_id: 'sha256:x', projects: { pwned: {} } },
    }),
  );
  const filePath = path.join(root, 'state.json');
  fs.symlinkSync(secret, filePath, 'file');

  const store = new DurableStore({ filePath, persist: true });
  await assert.rejects(
    () => store.initialize(),
    (e) => e.code === 'state-file-symlink',
  );
  // Security outcome: the outside secret was never ingested as state.
  assert.equal(Object.keys(store.state.receipts).length, 0, 'no outside receipt ingested');
});

test('DurableStore.load: symlinked containing DIRECTORY fails closed', async () => {
  const root = tmp('ds-root2-');
  const outside = tmp('ds-outside2-');
  fs.writeFileSync(path.join(outside, 'state.json'), '{"version":1}');
  const linkedDir = path.join(root, 'statedir');
  fs.symlinkSync(outside, linkedDir, 'dir');
  const filePath = path.join(linkedDir, 'state.json');

  const store = new DurableStore({ filePath, persist: true });
  await assert.rejects(
    () => store.initialize(),
    (e) => e.code === 'state-dir-symlink',
  );
});

test('LocalMemoryStore.load: legitimate memory loads correctly', async () => {
  const dir = tmp('lm-ok-');
  const filePath = path.join(dir, 'memory.json');
  const env = { NODE_ENV: 'production', LOCAL_MEMORY_PATH: filePath };
  const seed = new LocalMemoryStore(env, { defaultPath: filePath });
  await seed.remember('proj', 'ns', 'hello');

  const reopened = new LocalMemoryStore(env, { defaultPath: filePath });
  const recalled = await reopened.recall('proj', 10);
  assert.equal(recalled.results.length, 1);
  assert.equal(recalled.results[0].text, 'hello');
});

test('LocalMemoryStore.load: symlinked memory FILE fails closed, no outside read', async () => {
  const root = tmp('lm-root-');
  const outside = tmp('lm-outside-');
  const secret = path.join(outside, 'secret.json');
  fs.writeFileSync(
    secret,
    JSON.stringify({ projects: { pwned: [{ blob_id: 'x', text: 'OUTSIDE SECRET' }] } }),
  );
  const filePath = path.join(root, 'memory.json');
  fs.symlinkSync(secret, filePath, 'file');
  const env = { NODE_ENV: 'production', LOCAL_MEMORY_PATH: filePath };

  const store = new LocalMemoryStore(env, { defaultPath: filePath });
  await assert.rejects(
    () => store.recall('pwned', 10),
    (e) => e.code === 'state-file-symlink',
  );
});

// SEC-03 increment 3: the read boundary must validate the FULL ancestor chain,
// not just the immediate parent. A symlinked ancestor above the parent directory
// must be rejected on read exactly as the writer already rejects it.

// Layout: root/<mid>/inner/<file>, where root/<mid> is a symlink to `outside`,
// and outside/inner/<file> is the attacker's secret.
function plantAncestorSymlink(fileName, secretContents, { depth = 1 } = {}) {
  const root = tmp('anc-root-');
  const outside = tmp('anc-out-');
  fs.mkdirSync(path.join(outside, 'inner'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'inner', fileName), secretContents);
  // Optional extra real directories between root and the symlink to exercise a
  // deeper nested chain: root/a/b/<mid> -> outside.
  const prefix = Array.from({ length: depth - 1 }, (_, i) => `d${i}`);
  const midParent = path.join(root, ...prefix);
  fs.mkdirSync(midParent, { recursive: true });
  fs.symlinkSync(outside, path.join(midParent, 'mid'), 'dir');
  const filePath = path.join(midParent, 'mid', 'inner', fileName);
  return { root, outside, filePath };
}

test('SEC-03 REGRESSION: reader rejects a symlinked ANCESTOR directory (no outside read)', async () => {
  const { filePath, outside } = plantAncestorSymlink(
    'state.json',
    JSON.stringify({ version: 1, receipts: { STOLEN: { completedAt: Date.now(), value: 'pwn' } }, pending: {}, exact_state: { version: 1, relayer_index_id: 'sha256:x', projects: {} } }),
  );
  // Direct boundary helper must fail closed.
  await assert.rejects(() => readContainedStateFile(filePath), (e) => e.code === 'state-dir-symlink');

  const store = new DurableStore({ filePath, persist: true });
  await assert.rejects(() => store.initialize(), (e) => e.code === 'state-dir-symlink');
  assert.equal(Object.keys(store.state.receipts).length, 0, 'no outside receipt ingested');
  // Outside file untouched.
  assert.equal(JSON.parse(fs.readFileSync(path.join(outside, 'inner', 'state.json'), 'utf8')).receipts.STOLEN.value, 'pwn');
});

test('SEC-03 REGRESSION: reader rejects a DEEP nested ancestor chain', async () => {
  const { filePath } = plantAncestorSymlink('state.json', '{"version":1}', { depth: 3 });
  await assert.rejects(() => readContainedStateFile(filePath), (e) => e.code === 'state-dir-symlink');
});

test('SEC-03 REGRESSION: reader and writer reject the identical ancestor layout', async () => {
  const { filePath } = plantAncestorSymlink('state.json', '{"version":1}');
  const dir = path.dirname(filePath);
  // Writer (create path) rejects.
  await assert.rejects(() => ensureRealDirectoryPath(dir), (e) => e.code === 'state-dir-symlink');
  // Reader (no-create path) rejects with the same code.
  await assert.rejects(() => readContainedStateFile(filePath), (e) => e.code === 'state-dir-symlink');
});

test('SEC-03 REGRESSION: LocalMemory reader rejects a symlinked ancestor (no outside read)', async () => {
  const { filePath } = plantAncestorSymlink('memory.json', JSON.stringify({ projects: { pwned: [{ blob_id: 'x', text: 'OUTSIDE SECRET' }] } }));
  const env = { NODE_ENV: 'production', LOCAL_MEMORY_PATH: filePath };
  const store = new LocalMemoryStore(env, { defaultPath: filePath });
  await assert.rejects(() => store.recall('pwned', 10), (e) => e.code === 'state-dir-symlink');
});

test('SEC-03: legitimate NESTED real directories still load and round-trip', async () => {
  const root = tmp('nest-ok-');
  const filePath = path.join(root, 'a', 'b', 'state.json'); // all real dirs
  const seed = new DurableStore({ filePath, persist: true });
  await seed.complete('job-nested', { ok: true });
  const reopened = new DurableStore({ filePath, persist: true });
  assert.deepEqual(await reopened.getReceipt('job-nested'), { ok: true });
});

// SEC-03 final cleanup — Minor 1: LocalMemory boundary rejection must stay sticky
// (repeated calls keep failing closed until the hostile path is corrected), never
// silently degrading to an empty store, and must never ingest outside memory.
test('SEC-03: LocalMemory fails closed on EVERY call while an ancestor symlink stands, then recovers', async () => {
  const { root, filePath } = plantAncestorSymlink('m.json', JSON.stringify({ projects: { p: [{ blob_id: 'x', text: 'OUTSIDE SECRET' }] } }));
  const env = { NODE_ENV: 'production', LOCAL_MEMORY_PATH: filePath };
  const store = new LocalMemoryStore(env, { defaultPath: filePath });

  await assert.rejects(() => store.recall('p', 10), (e) => e.code === 'state-dir-symlink');
  // Second call must ALSO reject (previously it silently returned empty results).
  await assert.rejects(() => store.recall('p', 10), (e) => e.code === 'state-dir-symlink');
  assert.equal(store.memories.size, 0, 'no outside memory may be ingested');

  // Correct the path: replace the symlink with a real dir holding a legitimate file.
  const mid = path.join(root, 'mid');
  fs.unlinkSync(mid);
  fs.mkdirSync(path.join(mid, 'inner'), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ projects: { p: [{ blob_id: 'ok', text: 'legit' }] } }));
  const recalled = await store.recall('p', 10);
  assert.equal(recalled.results.length, 1);
  assert.equal(recalled.results[0].text, 'legit');
});

// SEC-03 final cleanup — Minor 2: credentials fallback READ must not disclose an
// outside secret reached through a symlinked ancestor of the owner-home path.
test('SEC-03: credentials fallback read fails closed on a symlinked ancestor (no secret disclosed)', async () => {
  const home = tmp('cred-home-');
  const outside = tmp('cred-out-');
  fs.mkdirSync(path.join(outside, '.noosphere'), { recursive: true });
  const outsideSecret = path.join(outside, '.noosphere', 'credentials-default.json');
  fs.writeFileSync(outsideSecret, 'SECRET-OUTSIDE');
  // Attacker points ~/.noosphere (the ancestor of the credential file) outside.
  fs.symlinkSync(path.join(outside, '.noosphere'), path.join(home, '.noosphere'), 'dir');

  const store = new CredentialStore('default', { platform: 'linux', home, run: () => ({ status: 1, stdout: '' }) });
  const value = store.getPassword();
  assert.notEqual(value, 'SECRET-OUTSIDE', 'outside credential must never be returned');
  assert.equal(value, null, 'fallback read must fail closed to null');
  assert.equal(fs.readFileSync(outsideSecret, 'utf8'), 'SECRET-OUTSIDE', 'outside credential file must be untouched');
});

// SEC-03 final cleanup — optional invariant: a missing nested read returns absent
// (null) and creates nothing (guards the reader's create:false contract).
test('SEC-03: reading a missing nested state path returns null and mutates nothing', async () => {
  const root = tmp('nomut-');
  const filePath = path.join(root, 'a', 'b', 'state.json'); // none of a/, a/b/, or the file exist
  const before = fs.readdirSync(root);
  const raw = await readContainedStateFile(filePath);
  assert.equal(raw, null, 'absent chain reads as null');
  assert.deepEqual(fs.readdirSync(root), before, 'reader must not create directories');
  assert.equal(before.length, 0, 'root stays empty');
});
