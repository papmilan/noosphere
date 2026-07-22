import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DurableStore } from '../durable-store.js';
import { LocalMemoryStore } from '../local-memory.js';

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
