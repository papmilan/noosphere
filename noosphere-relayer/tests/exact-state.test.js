import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import {
  canonicalize,
  digestHeadSet,
  encodeEnvelope,
} from '@noosphere/acp-protocol';
import { DurableStore } from '../durable-store.js';
import { FileSnapshotBackend } from '../snapshot-backend.js';
import { ExactStateService } from '../exact-state.js';
import { WalrusSnapshotBackend } from '../walrus-snapshot-backend.js';

const PROJECT = 'noosphere';
const EMPTY_HEAD_DIGEST = digestHeadSet([]);
const dirs = [];

async function tmpDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'noosphere-exact-'));
  dirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

// Build a fully signed (content-addressed) exact envelope with a chosen parent.
function makeEnvelope({ parent = null, objective = 'do the thing', expiresAt = null } = {}) {
  const envelope = encodeEnvelope({
    envelope: {
      protocol: 'acp.project-state-envelope',
      schema_version: '1.0.0',
      snapshot_id: 'sha256:' + '0'.repeat(64),
      parent_snapshot_id: parent,
      created_at: '2026-07-12T00:00:00.000Z',
      expires_at: expiresAt,
      origin: { agent_id: 'codex', client: 'test', session_id: null },
      integrity: {
        algorithm: 'sha256',
        digest: '0'.repeat(64),
        signature: { status: 'unsigned', algorithm: null, key_id: null, value: null },
      },
      permission_scope: 'project',
      trust: { level: 'local-unverified', reasons: ['test'] },
      repository: {
        project_id: PROJECT,
        root_identity: 'sha256:' + 'a'.repeat(64),
        head: null,
        branch: null,
        merge_base: null,
        dirty: false,
        workspace_fingerprint: 'sha256:' + 'b'.repeat(64),
      },
      phase: 'implementation',
      goal: { project: 'p', current_objective: objective, success_conditions: [] },
      plan: [], completed_work: [], decisions: [], evidence: [], assumptions: [],
      rejected_approaches: [], unknowns: [], blockers: [], risks: [], conflicts: [],
      working_stance: { confidence: 'medium', momentum: 'progressing', risk_posture: 'verify-before-change', attention: [], dissatisfaction: [], successor_behavior: [] },
      next_actions: [], references: [], extensions: {},
    },
  });
  return { envelope, id: envelope.snapshot_id, bytes: Buffer.from(canonicalize(envelope), 'utf8') };
}

async function fixture({ limits, shared = false, indexShared = false } = {}) {
  const dir = await tmpDir();
  const index = new DurableStore({ filePath: path.join(dir, 'state.json'), shared: indexShared });
  const backend = new FileSnapshotBackend({ root: path.join(dir, 'snapshots'), shared });
  const service = new ExactStateService({ backend, index, limits });
  return { dir, index, backend, service };
}

describe('FileSnapshotBackend', () => {
  it('stores canonical bytes and is byte-identical idempotent', async () => {
    const { backend } = await fixture();
    const { id, bytes } = makeEnvelope();
    const first = await backend.put(PROJECT, id, bytes);
    assert.equal(first.bytes, bytes.length);
    await backend.put(PROJECT, id, bytes); // idempotent, no throw
    assert.deepEqual(await backend.get(PROJECT, id), bytes);
    // POSIX mode bits carry no owner-only meaning on Windows, where the same
    // guarantee is an explicit SID ACL — asserted separately by
    // windows-acl.test.js ("FileSnapshotBackend snapshot is owner-only").
    // Only this assertion is platform-bound; the round-trip above is not.
    if (process.platform !== 'win32') {
      assert.equal((await stat(backend.pathFor(PROJECT, id))).mode & 0o777, 0o600);
    }
  });

  it('rejects the same id with different bytes', async () => {
    const { backend } = await fixture();
    const { id, bytes } = makeEnvelope();
    await backend.put(PROJECT, id, bytes);
    await assert.rejects(
      backend.put(PROJECT, id, Buffer.concat([bytes, Buffer.from('x')])),
      /snapshot-integrity-conflict/,
    );
  });
});

describe('ExactStateService head index', () => {
  it('uses the relayer envelope boundary before storing exact bytes', async () => {
    const { service } = await fixture();
    const malformed = makeEnvelope().envelope;
    delete malformed.goal;
    const resigned = encodeEnvelope({ envelope: malformed });
    await assert.rejects(service.putSnapshot(PROJECT, resigned, EMPTY_HEAD_DIGEST),
      (error) => error.details.some(({ code }) => code === 'required'));
    assert.deepEqual((await service.getHeads(PROJECT)).heads, []);
  });

  it('starts with the canonical empty digest and sorts independent heads', async () => {
    const { service } = await fixture();
    assert.deepEqual(await service.getHeads(PROJECT), {
      heads: [], head_records: [], heads_digest: EMPTY_HEAD_DIGEST, complete: true,
    });
    const z = makeEnvelope({ objective: 'z' });
    const a = makeEnvelope({ objective: 'a' });
    const first = await service.putSnapshot(PROJECT, z.envelope, EMPTY_HEAD_DIGEST);
    await service.putSnapshot(PROJECT, a.envelope, first.heads_digest);
    assert.deepEqual((await service.getHeads(PROJECT)).heads, [z.id, a.id].sort());
  });

  it('makes an out-of-order child actionable when its parent arrives', async () => {
    const { service } = await fixture();
    const parent = makeEnvelope({ objective: 'parent' });
    const child = makeEnvelope({ parent: parent.id, objective: 'child' });

    const childStored = await service.putSnapshot(PROJECT, child.envelope, EMPTY_HEAD_DIGEST);
    let heads = await service.getHeads(PROJECT);
    assert.equal(heads.complete, false);
    assert.deepEqual(heads.heads, [child.id]);

    await service.putSnapshot(PROJECT, parent.envelope, childStored.heads_digest);
    heads = await service.getHeads(PROJECT);
    assert.deepEqual(heads.heads, [child.id]);
    assert.equal(heads.complete, true);
  });

  it('replaces a parent head with its child', async () => {
    const { service } = await fixture();
    const parent = makeEnvelope({ objective: 'parent' });
    const child = makeEnvelope({ parent: parent.id, objective: 'child' });
    const p = await service.putSnapshot(PROJECT, parent.envelope, EMPTY_HEAD_DIGEST);
    await service.putSnapshot(PROJECT, child.envelope, p.heads_digest);
    assert.deepEqual((await service.getHeads(PROJECT)).heads, [child.id]);
  });

  it('returns an existing receipt for an identical idempotent upload', async () => {
    const { service } = await fixture();
    const snapshot = makeEnvelope();
    const first = await service.putSnapshot(PROJECT, snapshot.envelope, EMPTY_HEAD_DIGEST);
    const replay = await service.putSnapshot(PROJECT, snapshot.envelope, first.heads_digest);
    assert.equal(first.created, true);
    assert.equal(replay.created, false);
    assert.deepEqual(replay.storage, first.storage);
  });

  it('does not upload an identical replay twice but still detects stored byte conflicts', async () => {
    const value = await fixture();
    let uploads = 0;
    const adapter = { async put() { uploads += 1; return { blobId: 'blob-1' }; } };
    const backend = new WalrusSnapshotBackend({ adapter, exactCopy: value.backend });
    const service = new ExactStateService({ backend, index: value.index });
    const snapshot = makeEnvelope();
    const first = await service.putSnapshot(PROJECT, snapshot.envelope, EMPTY_HEAD_DIGEST);
    await service.putSnapshot(PROJECT, snapshot.envelope, first.heads_digest);
    assert.equal(uploads, 1);
    await writeFile(value.backend.pathFor(PROJECT, snapshot.id), Buffer.concat([snapshot.bytes, Buffer.from('x')]));
    await assert.rejects(
      service.putSnapshot(PROJECT, snapshot.envelope, first.heads_digest),
      /snapshot-integrity-conflict/,
    );
  });

  it('creates two heads for concurrent children of one parent', async () => {
    const { service } = await fixture();
    const parent = makeEnvelope({ objective: 'parent' });
    const a = makeEnvelope({ parent: parent.id, objective: 'child-a' });
    const b = makeEnvelope({ parent: parent.id, objective: 'child-b' });
    const p = await service.putSnapshot(PROJECT, parent.envelope, EMPTY_HEAD_DIGEST);
    const afterA = await service.putSnapshot(PROJECT, a.envelope, p.heads_digest);
    await service.putSnapshot(PROJECT, b.envelope, afterA.heads_digest);
    const heads = await service.getHeads(PROJECT);
    assert.deepEqual(heads.heads, [a.id, b.id].sort());
    assert.equal(heads.complete, true);
  });

  it('rejects a stale expected-head digest without mutating the index but keeps the bytes', async () => {
    const { service, backend, index } = await fixture();
    const child = makeEnvelope();
    const before = await service.getHeads(PROJECT);
    await assert.rejects(
      service.putSnapshot(PROJECT, child.envelope, `sha256:${'f'.repeat(64)}`),
      /stale-heads/,
    );
    assert.deepEqual(await service.getHeads(PROJECT), before);
    assert.deepEqual(await backend.get(PROJECT, child.id), child.bytes);
    const record = await index.readExactProject(PROJECT);
    assert.equal(record.snapshots[child.id], undefined);
  });

  it('rebuilds the same heads after a restart', async () => {
    const { dir, service } = await fixture();
    const parent = makeEnvelope({ objective: 'parent' });
    const child = makeEnvelope({ parent: parent.id, objective: 'child' });
    const p = await service.putSnapshot(PROJECT, parent.envelope, EMPTY_HEAD_DIGEST);
    await service.putSnapshot(PROJECT, child.envelope, p.heads_digest);
    const before = await service.getHeads(PROJECT);

    const index2 = new DurableStore({ filePath: path.join(dir, 'state.json') });
    const backend2 = new FileSnapshotBackend({ root: path.join(dir, 'snapshots') });
    const service2 = new ExactStateService({ backend: backend2, index: index2 });
    assert.deepEqual(await service2.getHeads(PROJECT), before);
  });

  it('rejects a snapshot over the byte limit before publishing it', async () => {
    const { service } = await fixture();
    const huge = makeEnvelope({ objective: 'x'.repeat(2_000_000) });
    await assert.rejects(
      service.putSnapshot(PROJECT, huge.envelope, EMPTY_HEAD_DIGEST),
      /snapshot-too-large/,
    );
    assert.deepEqual((await service.getHeads(PROJECT)).heads, []);
  });

  it('stores an expired envelope as non-actionable history', async () => {
    const { service } = await fixture();
    const expired = makeEnvelope({ expiresAt: '2026-07-12T00:00:01.000Z' });
    const stored = await service.putSnapshot(PROJECT, expired.envelope, EMPTY_HEAD_DIGEST, {
      now: () => Date.parse('2026-07-13T00:00:00.000Z'),
    });
    assert.equal(stored.actionable, false);
    assert.deepEqual((await service.getSnapshot(PROJECT, expired.id)).bytes, expired.bytes);
    assert.equal((await service.getHistory(PROJECT, { head: expired.id }))[0].snapshot_id, expired.id);
    assert.deepEqual((await service.getHeads(PROJECT)).head_records, [{
      snapshot_id: expired.id,
      expires_at: '2026-07-12T00:00:01.000Z',
      actionable: false,
    }]);
  });

  it('rejects the 33rd independent head without publishing index metadata', async () => {
    const { service, index } = await fixture();
    let digest = EMPTY_HEAD_DIGEST;
    for (let number = 0; number < 32; number += 1) {
      digest = (await service.putSnapshot(PROJECT, makeEnvelope({ objective: `head-${number}` }).envelope, digest)).heads_digest;
    }
    const rejected = makeEnvelope({ objective: 'head-32' });
    await assert.rejects(service.putSnapshot(PROJECT, rejected.envelope, digest), /head-limit/);
    assert.equal((await service.getHeads(PROJECT)).heads.length, 32);
    assert.equal((await index.readExactProject(PROJECT)).snapshots[rejected.id], undefined);
  });

  it('enforces indexed count and byte quotas before index publication', async () => {
    const one = makeEnvelope({ objective: 'one' });
    const two = makeEnvelope({ objective: 'two' });
    const count = await fixture({ limits: { snapshotBytes: 1_048_576, indexedSnapshotsPerProject: 1, concurrentHeadsPerProject: 32, ancestryEnvelopes: 200, indexedBytesPerProject: 268_435_456 } });
    const first = await count.service.putSnapshot(PROJECT, one.envelope, EMPTY_HEAD_DIGEST);
    await assert.rejects(count.service.putSnapshot(PROJECT, two.envelope, first.heads_digest), /snapshot-index-limit/);
    assert.equal(Object.keys((await count.index.readExactProject(PROJECT)).snapshots).length, 1);

    const bytes = await fixture({ limits: { snapshotBytes: 1_048_576, indexedSnapshotsPerProject: 10, concurrentHeadsPerProject: 32, ancestryEnvelopes: 200, indexedBytesPerProject: one.bytes.length } });
    const stored = await bytes.service.putSnapshot(PROJECT, one.envelope, EMPTY_HEAD_DIGEST);
    await assert.rejects(bytes.service.putSnapshot(PROJECT, two.envelope, stored.heads_digest), /project-byte-limit/);
    assert.equal(Object.keys((await bytes.index.readExactProject(PROJECT)).snapshots).length, 1);
  });

  it('persists a stable index identity and reports honest local/shared capability', async () => {
    const local = await fixture();
    const first = await local.service.getCapabilities();
    assert.equal(first.deployment_mode, 'local-only');
    assert.equal(first.cross_machine_recoverable, false);
    const restarted = new DurableStore({ filePath: path.join(local.dir, 'state.json') });
    assert.equal(await restarted.exactStateIdentity(), first.relayer_index_id);
    const sharedBytesOnly = await fixture({ shared: true });
    assert.equal((await sharedBytesOnly.service.getCapabilities()).cross_machine_recoverable, false);
    const explicitShared = await fixture({ shared: true, indexShared: true });
    assert.equal((await explicitShared.service.getCapabilities()).cross_machine_recoverable, true);
  });
});

describe('WalrusSnapshotBackend', () => {
  it('uploads a replica, never recalls semantically, and falls back to its exact copy', async () => {
    const { backend: exactCopy, index } = await fixture();
    const calls = [];
    const adapter = {
      async remember(value) { calls.push(value); return { blob_id: 'blob-1' }; },
      async recall() { throw new Error('semantic recall must not be called'); },
    };
    const backend = new WalrusSnapshotBackend({ adapter, exactCopy, indexHealth: () => index.health() });
    const snapshot = makeEnvelope();
    await backend.put(PROJECT, snapshot.id, snapshot.bytes);
    assert.deepEqual(await backend.get(PROJECT, snapshot.id), snapshot.bytes);
    assert.equal(calls.length, 1);
    assert.deepEqual(await backend.health(), {
      ready: true, durable: true, shared: true,
      deployment_mode: 'walrus-backed/relayer-indexed', exact_bytes_durable: true,
      index_durable: true, cross_machine_recoverable: false, walrus_exact_read: false,
    });
  });

  it('lets the service advertise the Walrus-backed deployment mode', async () => {
    const fixtureValue = await fixture();
    const adapter = { async put() { return { blobId: 'blob' }; } };
    const backend = new WalrusSnapshotBackend({
      adapter,
      exactCopy: fixtureValue.backend,
      indexHealth: () => fixtureValue.index.health(),
    });
    const service = new ExactStateService({ backend, index: fixtureValue.index });
    assert.equal((await service.getCapabilities()).deployment_mode, 'walrus-backed/relayer-indexed');
    assert.equal((await service.getCapabilities()).cross_machine_recoverable, false);
  });

  it('uses the persisted Walrus locator after restart and falls back to the exact copy', async () => {
    const value = await fixture();
    const snapshot = makeEnvelope();
    const adapter = {
      async put() { return { blobId: 'durable-blob' }; },
      async getByBlobId(locator) {
        assert.equal(locator, 'durable-blob');
        return snapshot.bytes;
      },
    };
    const first = new ExactStateService({
      backend: new WalrusSnapshotBackend({ adapter, exactCopy: value.backend }),
      index: value.index,
    });
    await first.putSnapshot(PROJECT, snapshot.envelope, EMPTY_HEAD_DIGEST);
    const restarted = new ExactStateService({
      backend: new WalrusSnapshotBackend({ adapter, exactCopy: value.backend }),
      index: new DurableStore({ filePath: path.join(value.dir, 'state.json') }),
    });
    assert.deepEqual((await restarted.getSnapshot(PROJECT, snapshot.id)).bytes, snapshot.bytes);

    adapter.getByBlobId = async () => { throw new Error('Walrus unavailable'); };
    assert.deepEqual((await restarted.getSnapshot(PROJECT, snapshot.id)).bytes, snapshot.bytes);
  });
});

describe('DurableStore compatibility', () => {
  it('loads version-1 state without exact_state and adds a durable identity', async () => {
    const dir = await tmpDir();
    const filePath = path.join(dir, 'state.json');
    await writeFile(filePath, '{"version":1,"receipts":{},"pending":{}}');
    const store = new DurableStore({ filePath });
    assert.match(await store.exactStateIdentity(), /^sha256:[0-9a-f]{64}$/);
    await store.updateExactProject(PROJECT, (record) => record);
    const restarted = new DurableStore({ filePath });
    assert.equal(await restarted.exactStateIdentity(), await store.exactStateIdentity());
  });
});
