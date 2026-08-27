import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import { ACP_LIMITS, canonicalize, digestHeadSet, encodeEnvelope } from '@noosphere/acp-protocol';
import {
  createExactRouter,
  isRetryableExactError,
  parseBoundedHistoryLimit,
  processAcpSnapshotJob,
  submitExactSnapshot,
} from '../exact-routes.js';
import { DurableStore } from '../durable-store.js';
import { ExactStateService } from '../exact-state.js';
import { exactError, FileSnapshotBackend } from '../snapshot-backend.js';
import { authenticationMiddleware, resolveSecurityConfig } from '../security.js';

describe('ACP exact-state HTTP boundary', () => {
  let server; let baseUrl;
  const snapshotId = `sha256:${'a'.repeat(64)}`;
  const service = {
    async getCapabilities() { return { deployment_mode: 'local-only', exact_bytes_durable: true, index_durable: true, cross_machine_recoverable: false, relayer_index_id: `sha256:${'b'.repeat(64)}`, sync_protocol_version: 'noosphere.acp-sync/1', reconciliation_policy_version: 'noosphere.acp-reconcile/1' }; },
    async putSnapshot(_projectId, envelope) { if (envelope.fail) throw exactError(envelope.fail, envelope.status); return { created: envelope.created !== false, snapshot_id: snapshotId, heads: [snapshotId] }; },
    async getHeads() { return { heads: [], heads_digest: 'empty', complete: true }; },
    async getSnapshot() { return { snapshot_id: snapshotId, bytes: Buffer.from('{"canonical":true}') }; },
    async getHistory(_projectId, options) { return [options]; },
  };
  before(async () => { const app = express(); app.use(express.json({ limit: '2mb' })); app.use('/v1', createExactRouter({ service, limits: ACP_LIMITS })); server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); baseUrl = `http://127.0.0.1:${server.address().port}/v1`; });
  after(() => new Promise((resolve) => server.close(resolve)));
  it('advertises exact-state topology and normative limits', async () => { const response = await fetch(`${baseUrl}/acp/capabilities`); const body = await response.json(); assert.equal(response.status, 200); assert.equal(body.cross_machine_recoverable, false); assert.deepEqual(body.limits, ACP_LIMITS); });
  it('maps create, replay, ETag, empty heads, and bounded history with the real index identity', async () => { const post = (envelope) => fetch(`${baseUrl}/projects/p/acp/snapshots`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ envelope, expected_heads_digest: 'empty' }) }); assert.equal((await post({ created: true })).status, 201); assert.equal((await post({ created: false })).status, 200); const snapshot = await fetch(`${baseUrl}/projects/p/acp/snapshots/${snapshotId}`); assert.equal(snapshot.headers.get('etag'), `"${snapshotId}"`); assert.equal(snapshot.headers.get('x-relayer-index-id'), `sha256:${'b'.repeat(64)}`); assert.equal(await snapshot.text(), '{"canonical":true}'); const heads = await fetch(`${baseUrl}/projects/p/acp/heads`); assert.equal(heads.headers.get('x-relayer-index-id'), `sha256:${'b'.repeat(64)}`); const headsBody = await heads.json(); assert.deepEqual(headsBody.heads, []); assert.equal(headsBody.sync_protocol_version, 'noosphere.acp-sync/1'); assert.equal(headsBody.deployment_mode, 'local-only'); assert.equal(headsBody.exact_bytes_durable, true); assert.deepEqual(headsBody.limits, ACP_LIMITS); const history = await fetch(`${baseUrl}/projects/p/acp/history?head=${snapshotId}&limit=1`); assert.equal(history.headers.get('x-relayer-index-id'), `sha256:${'b'.repeat(64)}`); assert.deepEqual((await history.json()).history, [{ head: snapshotId, limit: 1 }]); });
  it('maps exact-state failures without leaking payloads and retains index identity', async () => { for (const [code, status] of [['stale-heads', 409], ['head-limit', 409], ['snapshot-too-large', 413], ['invalid-envelope', 422], ['project-byte-limit', 507]]) { const response = await fetch(`${baseUrl}/projects/p/acp/snapshots`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ envelope: { fail: code, status, secret: 'do-not-log' } }) }); const body = await response.json(); assert.equal(response.status, status); assert.equal(response.headers.get('x-relayer-index-id'), `sha256:${'b'.repeat(64)}`); assert.equal(body.error, code); assert.equal(JSON.stringify(body).includes('do-not-log'), false); } });
  it('genericizes unknown server failures and redacts server logs', async () => {
    const original = console.error;
    const logs = [];
    console.error = (...values) => logs.push(values);
    try {
      const response = await fetch(`${baseUrl}/projects/p/acp/snapshots`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ envelope: { fail: 'secret-backend-path', status: 500 } }),
      });
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { success: false, error: 'internal-server-error' });
      assert.equal(JSON.stringify(logs).includes('secret-backend-path'), false);
    } finally {
      console.error = original;
    }
  });
  it('adds the real index identity to queued snapshot responses', async () => {
    const queued = express();
    queued.use(express.json());
    queued.use('/v1', createExactRouter({
      service,
      limits: ACP_LIMITS,
      submitSnapshot: async () => ({ status: 202, result: { pending: true, snapshot_id: snapshotId } }),
    }));
    const queuedServer = queued.listen(0, '127.0.0.1');
    await once(queuedServer, 'listening');
    try {
      const response = await fetch(`http://127.0.0.1:${queuedServer.address().port}/v1/projects/p/acp/snapshots`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      assert.equal(response.status, 202);
      assert.equal(response.headers.get('x-relayer-index-id'), `sha256:${'b'.repeat(64)}`);
    } finally {
      await new Promise((resolve) => queuedServer.close(resolve));
    }
  });
  it('rejects invalid history limits', () => { for (const value of ['0', '201', '1.5', 'no']) assert.throws(() => parseBoundedHistoryLimit(value, 1, 200), /history-limit/); assert.equal(parseBoundedHistoryLimit(undefined, 1, 200), 200); });
  it('inherits bearer authentication at the mounted API boundary', async () => {
    const secured = express();
    secured.use('/v1', authenticationMiddleware(resolveSecurityConfig({
      NODE_ENV: 'production', HOST: '127.0.0.1', NOOSPHERE_API_TOKEN: 'secret-token',
    })));
    secured.use('/v1', createExactRouter({ service, limits: ACP_LIMITS }));
    const securedServer = secured.listen(0, '127.0.0.1');
    await once(securedServer, 'listening');
    try {
      const url = `http://127.0.0.1:${securedServer.address().port}/v1/acp/capabilities`;
      assert.equal((await fetch(url)).status, 401);
      assert.equal((await fetch(url, { headers: { authorization: 'Bearer secret-token' } })).status, 200);
    } finally {
      await new Promise((resolve) => securedServer.close(resolve));
    }
  });
});

describe('ACP durable queue ordering', () => {
  it('replays an asynchronously completed exact receipt after its head advances', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'noosphere-acp-receipt-'));
    try {
      const store = new DurableStore({ filePath: path.join(directory, 'state.json') });
      const exact = new ExactStateService({
        backend: new FileSnapshotBackend({ root: path.join(directory, 'snapshots') }),
        index: store,
      });
      const envelope = exactEnvelope();
      const canonicalEnvelope = canonicalize(envelope);
      let offline = true;
      const service = {
        async putSnapshot(...args) {
          if (offline) throw Object.assign(new Error('offline'), { retryable: true });
          return exact.putSnapshot(...args);
        },
      };
      const args = {
        projectId: 'p', envelope, canonicalEnvelope, expectedHeadsDigest: digestHeadSet([]), service, store,
      };
      assert.equal((await submitExactSnapshot(args)).status, 202);
      offline = false;
      await processAcpSnapshotJob((await store.listPending())[0], { service, store });
      const advancedDigest = (await exact.getHeads('p')).heads_digest;
      assert.notEqual(advancedDigest, digestHeadSet([]));
      const replay = await submitExactSnapshot({ ...args, expectedHeadsDigest: advancedDigest });
      assert.equal(replay.status, 200);
      assert.equal(replay.result.deduplicated, true);
      assert.deepEqual(await store.listPending(), []);
      const differentSignature = structuredClone(envelope);
      differentSignature.integrity.signature.value = 'different-detached-signature';
      await assert.rejects(
        submitExactSnapshot({
          ...args, envelope: differentSignature, canonicalEnvelope: canonicalize(differentSignature),
          expectedHeadsDigest: advancedDigest,
        }),
        /snapshot-submission-conflict/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps heads invisible while queued and publishes only after restart recovery', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'noosphere-acp-queue-'));
    try {
      const filePath = path.join(directory, 'state.json');
      const snapshotId = `sha256:${'c'.repeat(64)}`;
      let durable = false;
      let heads = [];
      const service = {
        async putSnapshot() {
          if (!durable) throw Object.assign(new Error('offline'), { retryable: true });
          heads = [snapshotId];
          return { created: true, snapshot_id: snapshotId, heads };
        },
        async getHeads() { return { heads }; },
      };
      const first = new DurableStore({ filePath });
      const queued = await submitExactSnapshot({
        projectId: 'p',
        envelope: { snapshot_id: snapshotId },
        canonicalEnvelope: '{"snapshot_id":"' + snapshotId + '"}',
        expectedHeadsDigest: 'empty',
        service,
        store: first,
      });
      assert.equal(queued.status, 202);
      assert.deepEqual((await service.getHeads()).heads, []);

      durable = true;
      const restarted = new DurableStore({ filePath });
      const [job] = await restarted.listPending();
      await processAcpSnapshotJob(job, { service, store: restarted });
      assert.deepEqual((await service.getHeads()).heads, [snapshotId]);
      assert.equal((await restarted.listPending()).length, 0);
      assert.equal((await restarted.getReceipt(job.key)).snapshot_id, snapshotId);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('preserves CAS inputs across pending and completed replay', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'noosphere-acp-cas-'));
    try {
      const store = new DurableStore({ filePath: path.join(directory, 'state.json') });
      const envelope = { snapshot_id: `sha256:${'d'.repeat(64)}` };
      let offline = true;
      const service = {
        async putSnapshot(_project, _envelope, expected) {
          if (offline) throw Object.assign(new Error('offline'), { retryable: true });
          return { created: true, snapshot_id: envelope.snapshot_id, expected };
        },
      };
      const args = { projectId: 'p', envelope, canonicalEnvelope: JSON.stringify(envelope), service, store };
      assert.equal((await submitExactSnapshot({ ...args, expectedHeadsDigest: 'heads-a' })).status, 202);
      await assert.rejects(
        submitExactSnapshot({ ...args, expectedHeadsDigest: 'heads-b' }),
        /snapshot-submission-conflict/,
      );
      offline = false;
      const [job] = await store.listPending();
      await processAcpSnapshotJob(job, { service, store });
      const replay = await submitExactSnapshot({ ...args, expectedHeadsDigest: 'heads-a' });
      assert.equal(replay.result.deduplicated, true);
      assert.equal((await submitExactSnapshot({ ...args, expectedHeadsDigest: 'heads-b' })).result.deduplicated, true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('revives an identical terminal stale-heads job with freshly observed heads', async () => {
    const store = new DurableStore({ persist: false });
    const envelope = { snapshot_id: `sha256:${'f'.repeat(64)}` };
    const canonicalEnvelope = JSON.stringify(envelope);
    let offline = true;
    const service = {
      async putSnapshot(_project, _envelope, expected) {
        if (offline) throw Object.assign(new Error('offline'), { retryable: true });
        if (expected === 'heads-a') throw exactError('stale-heads', 409);
        return { created: true, snapshot_id: envelope.snapshot_id };
      },
    };
    const args = { projectId: 'p', envelope, canonicalEnvelope, service, store };
    assert.equal((await submitExactSnapshot({ ...args, expectedHeadsDigest: 'heads-a' })).status, 202);
    offline = false;
    await assert.rejects(processAcpSnapshotJob((await store.listPending())[0], { service, store }), /stale-heads/);

    const revived = await submitExactSnapshot({ ...args, expectedHeadsDigest: 'heads-b' });
    assert.equal(revived.status, 202);
    const [job] = await store.listPending();
    assert.equal(job.expectedHeadsDigest, 'heads-b');
    assert.notEqual(job.terminal, true);
    await processAcpSnapshotJob(job, { service, store });
    assert.equal((await store.getReceipt(job.key)).snapshot_id, envelope.snapshot_id);
  });

  it('recovers the second of two queued jobs after the first advances shared heads', async () => {
    const store = new DurableStore({ persist: false });
    const envelopes = ['1', '2'].map((char) => ({ snapshot_id: `sha256:${char.repeat(64)}` }));
    let offline = true;
    let headsDigest = 'empty';
    const history = [];
    const service = {
      async putSnapshot(_project, envelope, expected) {
        if (offline) throw Object.assign(new Error('offline'), { retryable: true });
        if (expected !== headsDigest) throw exactError('stale-heads', 409);
        history.push(envelope.snapshot_id);
        headsDigest = `heads-${history.length}`;
        return { created: true, snapshot_id: envelope.snapshot_id };
      },
    };
    for (const envelope of envelopes) {
      assert.equal((await submitExactSnapshot({
        projectId: 'p', envelope, canonicalEnvelope: JSON.stringify(envelope),
        expectedHeadsDigest: 'empty', service, store,
      })).status, 202);
    }
    offline = false;
    const jobs = await store.listPending();
    await processAcpSnapshotJob(jobs[0], { service, store });
    await assert.rejects(processAcpSnapshotJob(jobs[1], { service, store }), /stale-heads/);
    assert.equal((await submitExactSnapshot({
      projectId: 'p', envelope: envelopes[1], canonicalEnvelope: JSON.stringify(envelopes[1]),
      expectedHeadsDigest: headsDigest, service, store,
    })).status, 202);
    await processAcpSnapshotJob((await store.listPending())[0], { service, store });
    assert.deepEqual(history, envelopes.map(({ snapshot_id }) => snapshot_id));
  });

  it('does not queue normative quota failures', async () => {
    const store = new DurableStore({ persist: false });
    const envelope = { snapshot_id: `sha256:${'e'.repeat(64)}` };
    const service = { async putSnapshot() { throw exactError('project-byte-limit', 507); } };
    await assert.rejects(submitExactSnapshot({
      projectId: 'p', envelope, canonicalEnvelope: JSON.stringify(envelope),
      expectedHeadsDigest: 'empty', service, store,
    }), /project-byte-limit/);
    assert.deepEqual(await store.listPending(), []);
  });

  it('classifies only explicit or transient backend failures as retryable', () => {
    assert.equal(isRetryableExactError(Object.assign(new Error('offline'), { retryable: true })), true);
    assert.equal(isRetryableExactError(exactError('backend-unavailable', 503)), true);
    for (const [code, status] of [
      ['stale-heads', 409], ['head-limit', 409], ['project-byte-limit', 507],
      ['snapshot-index-limit', 507], ['invalid-protocol', 422],
    ]) assert.equal(isRetryableExactError(exactError(code, status)), false, code);
  });

  it('persists terminal ACP recovery failures and does not attempt them again', async () => {
    const store = new DurableStore({ persist: false });
    const envelope = { snapshot_id: `sha256:${'f'.repeat(64)}` };
    let calls = 0;
    const service = {
      async putSnapshot() {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('offline'), { retryable: true });
        throw exactError('stale-heads', 409);
      },
    };
    await submitExactSnapshot({
      projectId: 'p', envelope, canonicalEnvelope: JSON.stringify(envelope),
      expectedHeadsDigest: 'empty', service, store,
    });
    const [job] = await store.listPending();
    await assert.rejects(processAcpSnapshotJob(job, { service, store }), /stale-heads/);
    const terminal = await store.getPending(job.key);
    assert.equal(terminal.terminal, true);
    assert.deepEqual(terminal.terminalError, { code: 'stale-heads', status: 409 });
    assert.equal(terminal.lastError, 'stale-heads');
    await assert.rejects(processAcpSnapshotJob(terminal, { service, store }), /stale-heads/);
    assert.equal(calls, 2);
  });
});

function exactEnvelope() {
  return encodeEnvelope({ envelope: {
    protocol: 'acp.project-state-envelope', schema_version: '1.0.0', snapshot_id: `sha256:${'0'.repeat(64)}`,
    parent_snapshot_id: null, created_at: '2026-07-13T00:00:00.000Z', expires_at: null,
    origin: { agent_id: 'test', client: 'test', session_id: null },
    integrity: { algorithm: 'sha256', digest: '0'.repeat(64), signature: { status: 'unsigned', algorithm: null, key_id: null, value: null } },
    permission_scope: 'project', trust: { level: 'local-unverified', reasons: ['unsigned test fixture'] },
    repository: { project_id: 'p', root_identity: `sha256:${'a'.repeat(64)}`, head: null, branch: null, merge_base: null, dirty: false, workspace_fingerprint: `sha256:${'b'.repeat(64)}` },
    phase: 'implementation', goal: { project: 'p', current_objective: 'receipt replay', success_conditions: [] },
    plan: [], completed_work: [], decisions: [], evidence: [], assumptions: [], rejected_approaches: [], unknowns: [], blockers: [], risks: [], conflicts: [],
    working_stance: { confidence: 'medium', momentum: 'progressing', risk_posture: 'verify-before-change', attention: [], dissatisfaction: [], successor_behavior: [] },
    next_actions: [], references: [], extensions: {},
  } });
}
