import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import { ACP_LIMITS } from '@noosphere/acp-protocol';
import {
  createExactRouter,
  parseBoundedHistoryLimit,
  processAcpSnapshotJob,
  submitExactSnapshot,
} from '../exact-routes.js';
import { DurableStore } from '../durable-store.js';
import { exactError } from '../snapshot-backend.js';
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
  it('maps create, replay, ETag, empty heads, and bounded history', async () => { const post = (envelope) => fetch(`${baseUrl}/projects/p/acp/snapshots`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ envelope, expected_heads_digest: 'empty' }) }); assert.equal((await post({ created: true })).status, 201); assert.equal((await post({ created: false })).status, 200); const snapshot = await fetch(`${baseUrl}/projects/p/acp/snapshots/${snapshotId}`); assert.equal(snapshot.headers.get('etag'), `"${snapshotId}"`); assert.equal(await snapshot.text(), '{"canonical":true}'); assert.deepEqual((await (await fetch(`${baseUrl}/projects/p/acp/heads`)).json()).heads, []); assert.deepEqual((await (await fetch(`${baseUrl}/projects/p/acp/history?head=${snapshotId}&limit=1`)).json()).history, [{ head: snapshotId, limit: 1 }]); });
  it('maps exact-state failures without leaking payloads', async () => { for (const [code, status] of [['stale-heads', 409], ['head-limit', 409], ['snapshot-too-large', 413], ['invalid-envelope', 422], ['project-byte-limit', 507]]) { const response = await fetch(`${baseUrl}/projects/p/acp/snapshots`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ envelope: { fail: code, status, secret: 'do-not-log' } }) }); const body = await response.json(); assert.equal(response.status, status); assert.equal(body.error, code); assert.equal(JSON.stringify(body).includes('do-not-log'), false); } });
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
});
