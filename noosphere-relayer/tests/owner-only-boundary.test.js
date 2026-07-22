import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';

import { CredentialStore } from '../credentials.js';
import { DurableStore } from '../durable-store.js';
import { LocalMemoryStore } from '../local-memory.js';
import { FileSnapshotBackend } from '../snapshot-backend.js';

const SNAPSHOT_ID = `sha256:${'b'.repeat(64)}`;
const hash = (value) => createHash('sha256').update(String(value), 'utf8').digest('hex');

function temp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function boundary(events, { fail = false } = {}) {
  return {
    platform: 'win32',
    windowsAction({ action, file, input }) {
      events.push({ action, file, before: fs.existsSync(file) ? fs.statSync(file).size : null });
      if (fail) {
        const error = new Error('forced-security-failure');
        error.code = 'state-acl-failed';
        throw error;
      }
      if (action === 'write') {
        const fd = fs.openSync(file, 'wx', 0o600);
        try {
          assert.equal(fs.fstatSync(fd).size, 0, 'ACL verification occurs on an empty temp');
          fs.writeFileSync(fd, input);
        } finally {
          fs.closeSync(fd);
        }
        return Buffer.alloc(0);
      }
      if (action === 'read') return fs.readFileSync(file);
      throw new Error(`unexpected action ${action}`);
    },
  };
}

describe('relayer shared owner-only boundary', () => {
  test('credential fallback uses pre-write security and repair-before-read', () => {
    const home = temp('relayer-owner-cred-');
    const events = [];
    const store = new CredentialStore('default', {
      platform: 'freebsd',
      home,
      secureFileOptions: boundary(events),
    });
    store.setPassword('credential-secret');
    assert.equal(store.getPassword(), 'credential-secret');
    assert.deepEqual(events.map(({ action }) => action), ['write', 'read']);
    assert.equal(events[0].before, null, 'PowerShell owns exclusive temp creation');
  });

  test('DurableStore and LocalMemory repair existing state before parsing it', async () => {
    const dir = temp('relayer-owner-state-');
    const durablePath = path.join(dir, 'durable.json');
    const memoryPath = path.join(dir, 'memory.json');
    fs.writeFileSync(durablePath, JSON.stringify({ version: 1, receipts: {}, pending: {} }));
    fs.writeFileSync(memoryPath, JSON.stringify({ projects: {} }));
    const durableEvents = [];
    const memoryEvents = [];

    const durable = new DurableStore({
      filePath: durablePath,
      persist: true,
      secureFileOptions: boundary(durableEvents),
    });
    await durable.initialize();
    const memory = new LocalMemoryStore(
      { NODE_ENV: 'production', LOCAL_MEMORY_PATH: memoryPath },
      { defaultPath: memoryPath, secureFileOptions: boundary(memoryEvents) },
    );
    await memory.recall('project', 1);

    assert.equal(durableEvents[0].action, 'read');
    assert.equal(memoryEvents[0].action, 'read');
  });

  test('all temp-based stores cleanup on ACL failure and retain prior final state', async () => {
    const dir = temp('relayer-owner-fail-');
    const durablePath = path.join(dir, 'durable.json');
    const memoryPath = path.join(dir, 'memory.json');
    fs.writeFileSync(durablePath, 'previous-durable');
    fs.writeFileSync(memoryPath, 'previous-memory');
    const failedBoundary = boundary([], { fail: true });

    const durable = new DurableStore({ filePath: durablePath, persist: true, secureFileOptions: failedBoundary });
    durable.loaded = true;
    await assert.rejects(durable.complete('job', { ok: true }), (error) => error.code === 'state-acl-failed');

    const memory = new LocalMemoryStore(
      { NODE_ENV: 'production', LOCAL_MEMORY_PATH: memoryPath },
      { defaultPath: memoryPath, secureFileOptions: failedBoundary },
    );
    memory.loaded = true;
    await assert.rejects(memory.remember('p', 'n', 'secret'), (error) => error.code === 'state-acl-failed');

    const snapshotRoot = path.join(dir, 'snapshots');
    fs.mkdirSync(snapshotRoot);
    const snapshots = new FileSnapshotBackend({ root: snapshotRoot, secureFileOptions: failedBoundary });
    await assert.rejects(snapshots.put('project', SNAPSHOT_ID, Buffer.from('secret')), (error) => error.code === 'state-acl-failed');

    assert.equal(fs.readFileSync(durablePath, 'utf8'), 'previous-durable');
    assert.equal(fs.readFileSync(memoryPath, 'utf8'), 'previous-memory');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['durable.json', 'memory.json', 'snapshots']);
    assert.deepEqual(fs.readdirSync(snapshotRoot), [hash('project')]);
    assert.deepEqual(fs.readdirSync(path.join(snapshotRoot, hash('project'))), []);
  });

  test('snapshot read repairs before returning bytes', async () => {
    const root = temp('relayer-owner-snapshot-');
    const targetDir = path.join(root, hash('project'));
    const target = path.join(targetDir, `${hash(SNAPSHOT_ID)}.json`);
    fs.mkdirSync(targetDir);
    fs.writeFileSync(target, 'legacy-snapshot');
    const events = [];
    const snapshots = new FileSnapshotBackend({ root, secureFileOptions: boundary(events) });
    assert.equal((await snapshots.get('project', SNAPSHOT_ID)).toString(), 'legacy-snapshot');
    assert.equal(events[0].action, 'read');
  });
});
