import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import express from 'express';

process.env.DEMO_MODE = 'true';
process.env.NODE_ENV = 'test';

const {
  app,
  isRateLimited,
  parseTrustProxy,
  prioritizePendingJobs,
  retryDelayFor,
  runtimeStore,
} =
  await import('../index.js');
const { MemoryStore, memoryStore, parseMemory, serializeMemory } =
  await import('../memory.js');
const { resolveWalrusConfig, WALRUS_NETWORKS } =
  await import('../walrus-memory.js');
const { DurableStore, retryOperation } =
  await import('../durable-store.js');
const {
  authenticationMiddleware,
  corsMiddleware,
  rateLimitMiddleware,
  resolveSecurityConfig,
} = await import('../security.js');

describe('Noosphere memory API', () => {
  let server;
  let baseUrl;

  before(async () => {
    await memoryStore.resetDemo();
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('serializes and parses the portable memory envelope', () => {
    const record = {
      schema: 'noosphere.agent-memory.v2',
      project_id: 'demo',
      content: 'A remembered decision.',
    };
    assert.deepEqual(parseMemory(serializeMemory(record)), record);
    assert.equal(parseMemory('plain text from another namespace'), null);
    const circular = {};
    circular.self = circular;
    assert.throws(
      () => serializeMemory(circular),
      /Memory record cannot be serialized/,
    );
  });

  it('parses trust proxy configuration into Express-compatible values', () => {
    assert.equal(parseTrustProxy(undefined), undefined);
    assert.equal(parseTrustProxy('true'), true);
    assert.equal(parseTrustProxy('false'), false);
    assert.equal(parseTrustProxy('1'), 1);
    assert.equal(parseTrustProxy('loopback'), 'loopback');
  });

  it('selects matching Walrus and Sui network configuration', () => {
    const mainnet = resolveWalrusConfig({});
    const testnet = resolveWalrusConfig({ MEMWAL_NETWORK: 'testnet' });

    assert.equal(mainnet.network, 'mainnet');
    assert.equal(mainnet.relayerUrl, WALRUS_NETWORKS.mainnet.relayerUrl);
    assert.match(mainnet.rpcUrl, /mainnet/);
    assert.equal(testnet.network, 'testnet');
    assert.equal(testnet.relayerUrl, WALRUS_NETWORKS.testnet.relayerUrl);
    assert.match(testnet.rpcUrl, /testnet/);
  });

  it('rejects malformed or mismatched Walrus configuration early', () => {
    assert.throws(
      () => resolveWalrusConfig({ MEMWAL_NETWORK: 'devnet' }),
      /mainnet.*testnet/,
    );
    assert.throws(
      () =>
        resolveWalrusConfig({
          MEMWAL_PRIVATE_KEY: 'not-hex',
          MEMWAL_ACCOUNT_ID: `0x${'1'.repeat(64)}`,
        }),
      /64-character Ed25519/,
    );
    assert.throws(
      () =>
        resolveWalrusConfig({
          MEMWAL_PRIVATE_KEY: '1'.repeat(64),
          MEMWAL_ACCOUNT_ID: '1234',
        }),
      /Sui object ID/,
    );
  });

  it('requires authentication for production and non-loopback binding', () => {
    assert.throws(
      () => resolveSecurityConfig({ NODE_ENV: 'production' }),
      /NOOSPHERE_API_TOKEN/,
    );
    assert.throws(
      () => resolveSecurityConfig({ HOST: '0.0.0.0' }),
      /NOOSPHERE_API_TOKEN/,
    );

    const config = resolveSecurityConfig({
      HOST: '0.0.0.0',
      NODE_ENV: 'production',
      NOOSPHERE_API_TOKEN: 'test-secret',
      CORS_ORIGINS: 'https://app.noosphere.example',
    });
    assert.equal(config.host, '0.0.0.0');
    assert.equal(config.allowLoopbackWithoutToken, false);
    assert.deepEqual(config.corsOrigins, [
      'https://app.noosphere.example',
    ]);
  });

  it('enforces bearer auth, exact CORS origins, and rate limits', async () => {
    const protectedApp = express();
    const config = resolveSecurityConfig({
      NOOSPHERE_API_TOKEN: 'test-secret',
      ALLOW_LOOPBACK_WITHOUT_TOKEN: 'false',
      CORS_ORIGINS: 'https://allowed.example',
      RATE_LIMIT_MAX: '2',
    });
    protectedApp.use(corsMiddleware(config));
    protectedApp.use(rateLimitMiddleware(config, () => 1_000));
    protectedApp.use(authenticationMiddleware(config));
    protectedApp.get('/v1/test', (_req, res) => res.json({ ok: true }));
    const protectedServer = protectedApp.listen(0, '127.0.0.1');
    await once(protectedServer, 'listening');
    const protectedUrl =
      `http://127.0.0.1:${protectedServer.address().port}/v1/test`;

    try {
      const forbiddenOrigin = await fetch(protectedUrl, {
        headers: { origin: 'https://blocked.example' },
      });
      assert.equal(forbiddenOrigin.status, 403);

      const unauthorized = await fetch(protectedUrl, {
        headers: { origin: 'https://allowed.example' },
      });
      assert.equal(unauthorized.status, 401);

      const authorized = await fetch(protectedUrl, {
        headers: {
          authorization: 'Bearer test-secret',
          origin: 'https://allowed.example',
        },
      });
      assert.equal(authorized.status, 200);
      assert.equal(
        authorized.headers.get('access-control-allow-origin'),
        'https://allowed.example');

      const limited = await fetch(protectedUrl, {
        headers: {
          authorization: 'Bearer test-secret',
          origin: 'https://allowed.example',
        },
      });
      assert.equal(limited.status, 429);
    } finally {
      await new Promise((resolve) => protectedServer.close(resolve));
    }
  });

  it('persists pending jobs and idempotency receipts across restarts', async () => {
    const stateDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'noosphere-state-'),
    );
    const filePath = path.join(stateDirectory, 'state.json');
    const first = new DurableStore({ filePath });
    await first.enqueue('project:action', {
      projectId: 'project',
      serializedRecord: 'record',
      responseTemplate: { success: true },
    });

    const restarted = new DurableStore({ filePath });
    assert.equal(
      (await restarted.getPending('project:action')).projectId,
      'project',
    );
    await restarted.complete('project:action', {
      success: true,
      blob_id: 'remote-blob',
    });

    const secondRestart = new DurableStore({ filePath });
    assert.deepEqual(await secondRestart.getReceipt('project:action'), {
      success: true,
      blob_id: 'remote-blob',
    });
    assert.equal(await secondRestart.getPending('project:action'), null);
  });

  it('prioritizes explicit memories before the newest automatic checkpoints', () => {
    const jobs = [
      {
        key: 'project:checkpoint-old',
        actionType: 'checkpoint',
        createdAt: 1,
      },
      {
        key: 'project:decision-old',
        actionType: 'decision',
        createdAt: 2,
      },
      {
        key: 'project:checkpoint-new',
        actionType: 'checkpoint',
        createdAt: 4,
      },
      {
        key: 'project:review-new',
        actionType: 'review',
        createdAt: 3,
      },
    ];

    assert.deepEqual(
      prioritizePendingJobs(jobs).map((job) => job.key),
      [
        'project:decision-old',
        'project:review-new',
        'project:checkpoint-new',
        'project:checkpoint-old',
      ],
    );
  });

  it('retries temporary upload failures with exponential backoff', async () => {
    let calls = 0;
    const delays = [];
    const result = await retryOperation(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('temporary failure');
        return 'stored';
      },
      {
        attempts: 3,
        baseDelayMs: 10,
        sleep: async (delay) => delays.push(delay),
      },
    );

    assert.equal(result, 'stored');
    assert.equal(calls, 3);
    assert.deepEqual(delays, [10, 20]);
  });

  it('recovers the local persistence queue after a failed write', async () => {
    const store = new MemoryStore();
    store.persistDemo = true;
    let attempts = 0;
    store._writeDemoToDisk = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary disk failure');
    };

    await assert.rejects(
      store.persistDemoMemories(),
      /temporary disk failure/,
    );
    await assert.doesNotReject(store.persistDemoMemories());
    assert.equal(attempts, 2);
  });

  it('reports demo memory readiness', async () => {
    const response = await fetch(`${baseUrl}/ready`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.memory.mode, 'demo');
    assert.equal(body.memory.ready, true);
  });

  it('keeps liveness independent from Walrus readiness', async () => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: 'ok',
      service: 'Noosphere',
    });
  });

  it('recognizes Walrus cooldown hints without retrying immediately', () => {
    const error = new Error(
      'Walrus Memory server error (429): {"retry_after_seconds":300}',
    );
    assert.equal(isRateLimited(error), true);
    assert.equal(retryDelayFor(error, 1), 300_000);
  });

  it('ignores forwarded protocol headers unless trust proxy is enabled', async () => {
    const response = await fetch(
      `${baseUrl}/.well-known/noosphere.json`,
      { headers: { 'x-forwarded-proto': 'https' } },
    );
    const body = await response.json();

    assert.match(body.endpoints.remember, /^http:\/\//);
  });

  it('stores an action without blockchain-specific fields', async () => {
    const response = await fetch(`${baseUrl}/v1/actions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'remember-1',
      },
      body: JSON.stringify({
        project_id: 'test-project',
        agent_id: 'codex',
        action_type: 'decision',
        content: 'Use the official Walrus Memory SDK.',
        model: 'codex',
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.equal(body.success, true);
    assert.match(body.blob_id, /^demo-/);
    assert.equal(body.storage, 'demo');
    assert.deepEqual(Object.keys(body).sort(), [
      'action_id',
      'blob_id',
      'memory_id',
      'namespace',
      'storage',
      'success',
    ]);
    assert.equal('tx_digest' in body, false);
    assert.equal('genome_object_id' in body, false);
  });

  it('recalls stored records by project namespace', async () => {
    const response = await fetch(
      `${baseUrl}/v1/projects/test-project/recall`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: 'Which storage SDK did we choose?',
          limit: 5,
        }),
      },
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.retrieval, 'semantic');
    assert.equal(body.total, 1);
    assert.equal(body.memories[0].agent_id, 'codex');
    assert.match(body.memories[0].content, /official Walrus Memory SDK/);
  });

  it('returns only the portable memory fields from older records', async () => {
    await memoryStore.remember(
      'older-project',
      serializeMemory({
        schema: 'noosphere.agent-memory.v2',
        action_id: 'older-action',
        project_id: 'older-project',
        agent_id: 'older-agent',
        action_type: 'decision',
        content: 'Keep the shared memory format focused.',
        timestamp: '2026-06-12T00:00:00.000Z',
        obsolete_annotation: { value: 10 },
      }),
    );

    const response = await fetch(
      `${baseUrl}/v1/projects/older-project/recall`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'shared memory format', limit: 5 }),
      },
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.total, 1);
    assert.equal('obsolete_annotation' in body.memories[0], false);
  });

  it('returns prompt-ready semantic context', async () => {
    const response = await fetch(
      `${baseUrl}/v1/projects/test-project/context?format=text&q=storage`,
    );
    const text = await response.text();

    assert.match(response.headers.get('content-type'), /text\/plain/);
    assert.match(text, /NOOSPHERE CONTEXT: test-project/);
    assert.match(text, /Semantic query: storage/);
    assert.match(text, /Use the official Walrus Memory SDK/);
  });

  it('bootstraps any HTTP agent with protocol and current context', async () => {
    const response = await fetch(
      `${baseUrl}/v1/projects/test-project/bootstrap`,
    );
    const text = await response.text();

    assert.equal(response.status, 200);
    assert.match(text, /NOOSPHERE UNIVERSAL AGENT BOOTSTRAP/);
    assert.match(text, /Do not expose hidden chain-of-thought/);
    assert.match(text, /Use the official Walrus Memory SDK/);
  });

  it('deduplicates within the running process', async () => {
    const payload = JSON.stringify({
      project_id: 'test-project',
      agent_id: 'codex',
      action_type: 'review',
      content: 'Reviewed the simplified architecture.',
    });
    const headers = {
      'content-type': 'application/json',
      'idempotency-key': 'same-action',
    };
    const first = await fetch(`${baseUrl}/v1/actions`, {
      method: 'POST',
      headers,
      body: payload,
    });
    const firstBody = await first.json();
    const second = await fetch(`${baseUrl}/v1/actions`, {
      method: 'POST',
      headers,
      body: payload,
    });
    const secondBody = await second.json();

    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(secondBody.deduplicated, true);
    assert.equal(secondBody.blob_id, firstBody.blob_id);
  });

  it('expires idempotency receipts after 24 hours', async () => {
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    const payload = JSON.stringify({
      project_id: 'test-project',
      agent_id: 'codex',
      action_type: 'review',
      content: 'Receipt expiry check.',
    });
    const headers = {
      'content-type': 'application/json',
      'idempotency-key': 'expiring-action',
    };

    try {
      const first = await fetch(`${baseUrl}/v1/actions`, {
        method: 'POST',
        headers,
        body: payload,
      });
      const firstBody = await first.json();
      now += 24 * 60 * 60 * 1000 + 1;
      const second = await fetch(`${baseUrl}/v1/actions`, {
        method: 'POST',
        headers,
        body: payload,
      });
      const secondBody = await second.json();

      assert.equal(first.status, 201);
      assert.equal(second.status, 201);
      assert.notEqual(secondBody.blob_id, firstBody.blob_id);
      assert.equal(secondBody.deduplicated, undefined);
    } finally {
      Date.now = realNow;
    }
  });

  it('publishes the simplified discovery and OpenAPI documents', async () => {
    const [homeResponse, discoveryResponse, openApiResponse] = await Promise.all([
      fetch(`${baseUrl}/`),
      fetch(`${baseUrl}/.well-known/noosphere.json`),
      fetch(`${baseUrl}/openapi.json`),
    ]);
    const home = await homeResponse.text();
    const discovery = await discoveryResponse.json();
    const openApi = await openApiResponse.json();

    assert.equal(homeResponse.status, 200);
    assert.doesNotMatch(home, /Connect wallet|auth-overlay|data-auth-gate/);
    assert.equal(discovery.version, '2.0.0');
    assert.equal(discovery.architecture.custom_smart_contract, false);
    assert.equal(
      discovery.mcp.package,
      '@mysten-incubation/memwal-mcp',
    );
    assert.equal(openApi.info.version, '2.0.0');
    assert.ok(openApi.paths['/v1/projects/{project_id}/recall']);
    assert.ok(openApi.paths['/v1/projects/{project_id}/bootstrap']);
  });

  it('accepts a rate-limited write into the durable queue without duplication', async () => {
    const originalRemember = memoryStore.remember;
    let calls = 0;
    memoryStore.remember = async () => {
      calls += 1;
      throw new Error(
        'Walrus Memory server error (429): {"retry_after_seconds":300}',
      );
    };

    try {
      const request = {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'rate-limited-action',
        },
        body: JSON.stringify({
          project_id: 'queued-project',
          agent_id: 'codex',
          action_type: 'checkpoint',
          content: 'Queue this exactly once.',
          session_id: 'queue-test',
        }),
      };
      const first = await fetch(`${baseUrl}/v1/actions`, request);
      const firstBody = await first.json();
      assert.equal(first.status, 202);
      assert.equal(firstBody.pending, true);

      const second = await fetch(`${baseUrl}/v1/actions`, request);
      const secondBody = await second.json();
      assert.equal(second.status, 202);
      assert.equal(secondBody.pending, true);
      assert.equal(secondBody.deduplicated, true);
      assert.equal(calls, 1);
      assert.ok(
        await runtimeStore.getPending(
          'queued-project:rate-limited-action',
        ),
      );
    } finally {
      memoryStore.remember = originalRemember;
      await runtimeStore.clear();
    }
  });
});
