import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RECONCILIATION_POLICY_VERSION, SYNC_PROTOCOL_VERSION } from '@noosphere/acp-protocol';
import { RemoteStateClient, RemoteStateError } from '../continuity/acp/remote-client.js';

const SNAPSHOT = `sha256:${'a'.repeat(64)}`;
const INDEX = `sha256:${'b'.repeat(64)}`;
const json = (value, init = {}) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json', ...init.headers }, ...init });

describe('RemoteStateClient', () => {
  it('uses bearer authentication, encoded paths, CAS bodies, and propagates index identity', async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/capabilities')) return json({ sync_protocol_version: SYNC_PROTOCOL_VERSION, reconciliation_policy_version: RECONCILIATION_POLICY_VERSION, relayer_index_id: INDEX });
      if (options.method === 'POST') return json({ snapshot_id: SNAPSHOT, created: true }, { status: 201 });
      return json({ heads: [SNAPSHOT], heads_digest: INDEX }, { headers: { 'x-relayer-index-id': INDEX } });
    };
    const client = new RemoteStateClient({ baseUrl: 'https://relay.example/', token: 'token', fetchImpl });
    assert.equal((await client.capabilities()).relayer_index_id, INDEX);
    await client.putSnapshot('project/a', { snapshot_id: SNAPSHOT }, INDEX);
    await client.getHeads('project/a');
    assert.equal(calls.every(({ options }) => options.headers.authorization === 'Bearer token'), true);
    assert.match(calls[1].url, /project%2Fa/);
    assert.deepEqual(JSON.parse(calls[1].options.body), { envelope: { snapshot_id: SNAPSHOT }, expected_heads_digest: INDEX });
  });

  it('rejects unsupported capabilities and malformed index IDs', async () => {
    for (const body of [
      { sync_protocol_version: 'other', reconciliation_policy_version: RECONCILIATION_POLICY_VERSION, relayer_index_id: INDEX },
      { sync_protocol_version: SYNC_PROTOCOL_VERSION, reconciliation_policy_version: 'other', relayer_index_id: INDEX },
      { sync_protocol_version: SYNC_PROTOCOL_VERSION, reconciliation_policy_version: RECONCILIATION_POLICY_VERSION, relayer_index_id: 'bad' },
    ]) await assert.rejects(new RemoteStateClient({ baseUrl: 'https://x', fetchImpl: async () => json(body) }).capabilities(), RemoteStateError);
  });

  it('requires a pinned capability index and rejects identity changes across calls', async () => {
    const unpinned = new RemoteStateClient({ baseUrl: 'https://x', fetchImpl: async () => json({ heads: [] }, { headers: { 'x-relayer-index-id': INDEX } }) });
    await assert.rejects(unpinned.getHeads('p'), /capabilities-required/);
    let current = INDEX;
    const client = new RemoteStateClient({ baseUrl: 'https://x', expectedRelayerIndexId: INDEX, fetchImpl: async () => json({ heads: [] }, { headers: { 'x-relayer-index-id': current } }) });
    await client.getHeads('p');
    current = `sha256:${'c'.repeat(64)}`;
    await assert.rejects(client.getHeads('p'), /relayer-index-mismatch/);
    await assert.rejects(new RemoteStateClient({ baseUrl: 'https://x', expectedRelayerIndexId: INDEX, fetchImpl: async () => json({ heads: [] }) }).getHeads('p'), /missing-relayer-index-id/);
  });

  it('bounds JSON and snapshot bodies to 1 MiB and rejects malformed JSON', async () => {
    const oversized = 'x'.repeat(1_048_577);
    await assert.rejects(new RemoteStateClient({ baseUrl: 'https://x', expectedRelayerIndexId: INDEX, fetchImpl: async () => new Response(oversized, { headers: { 'x-relayer-index-id': INDEX } }) }).getHeads('p'), /response-too-large/);
    await assert.rejects(new RemoteStateClient({ baseUrl: 'https://x', expectedRelayerIndexId: INDEX, fetchImpl: async () => new Response('{bad', { headers: { 'x-relayer-index-id': INDEX } }) }).getHeads('p'), /malformed-json/);
    await assert.rejects(new RemoteStateClient({ baseUrl: 'https://x', expectedRelayerIndexId: INDEX, fetchImpl: async () => new Response(oversized, { headers: { 'x-relayer-index-id': INDEX } }) }).getSnapshot('p', SNAPSHOT), /response-too-large/);
    await assert.rejects(new RemoteStateClient({ baseUrl: 'https://x', fetchImpl: async () => { throw new Error('must not fetch'); } }).putSnapshot('p', { value: oversized }, INDEX), /request-too-large/);
  });

  it('returns exact bytes and headers only when ETag matches the requested snapshot', async () => {
    const bytes = Buffer.from('{"exact":true}');
    const client = new RemoteStateClient({ baseUrl: 'https://x', expectedRelayerIndexId: INDEX, fetchImpl: async () => new Response(bytes, { headers: { etag: `"${SNAPSHOT}"`, 'x-relayer-index-id': INDEX } }) });
    const result = await client.getSnapshot('p', SNAPSHOT);
    assert.deepEqual(result.bytes, bytes);
    assert.equal(result.etag, `"${SNAPSHOT}"`);
    assert.equal(result.relayer_index_id, INDEX);
    await assert.rejects(new RemoteStateClient({ baseUrl: 'https://x', expectedRelayerIndexId: INDEX, fetchImpl: async () => new Response(bytes, { headers: { etag: `"sha256:${'c'.repeat(64)}"`, 'x-relayer-index-id': INDEX } }) }).getSnapshot('p', SNAPSHOT), /snapshot-mismatch/);
  });

  it('aborts requests at the configured timeout', async () => {
    const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    await assert.rejects(new RemoteStateClient({ baseUrl: 'https://x', expectedRelayerIndexId: INDEX, fetchImpl, timeoutMs: 5 }).getHeads('p'), /request-timeout/);
    const slowBody = new ReadableStream({ start(controller) { setTimeout(() => { controller.enqueue(new TextEncoder().encode('{}')); controller.close(); }, 25); } });
    await assert.rejects(new RemoteStateClient({ baseUrl: 'https://x', expectedRelayerIndexId: INDEX, fetchImpl: async () => new Response(slowBody, { headers: { 'x-relayer-index-id': INDEX } }), timeoutMs: 5 }).getHeads('p'), /request-timeout/);
  });

  it('returns typed bounded server errors for normative statuses', async () => {
    for (const status of [409, 413, 422, 507]) {
      const client = new RemoteStateClient({ baseUrl: 'https://x', expectedRelayerIndexId: INDEX, fetchImpl: async () => json({ error: 'typed-error', details: [{ code: 'safe' }] }, { status, headers: { 'x-relayer-index-id': INDEX } }) });
      await assert.rejects(client.putSnapshot('p', {}, INDEX), (error) => error instanceof RemoteStateError && error.status === status && error.code === 'typed-error');
    }
  });

  it('exposes only exact-state endpoints', () => {
    const client = new RemoteStateClient({ baseUrl: 'https://x', fetchImpl: async () => json({}) });
    assert.deepEqual(['capabilities', 'putSnapshot', 'getHeads', 'getSnapshot', 'getHistory'].filter((name) => typeof client[name] === 'function').sort(), ['capabilities', 'getHeads', 'getHistory', 'getSnapshot', 'putSnapshot']);
    assert.equal(client.recall, undefined);
  });
});
