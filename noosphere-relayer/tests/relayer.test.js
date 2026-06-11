import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, describe, it } from 'node:test';

process.env.DEMO_MODE = 'true';
process.env.NODE_ENV = 'test';

const { app, parseTrustProxy, resolveActionScore } =
  await import('../index.js');
const { MemoryStore, memoryStore, parseMemory, serializeMemory } =
  await import('../memory.js');

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

  it('reports demo memory and scorer status', async () => {
    const response = await fetch(`${baseUrl}/health`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.memory.mode, 'demo');
    assert.equal(body.memory.ready, true);
    assert.equal(body.scorer_configured, false);
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
    assert.equal(body.storage, 'walrus-memory');
    assert.equal(body.score_delta, 0);
    assert.equal(body.score_status, 'private');
    assert.equal(body.privacy.remote_evaluation, false);
    assert.equal('tx_digest' in body, false);
    assert.equal('genome_object_id' in body, false);
  });

  it('ignores caller score input and always runs automatic evaluation', async () => {
    const result = await resolveActionScore(
      {
        project_id: 'test-project',
        agent_id: 'untrusted-agent',
        action_type: 'code',
        content: 'Caller cannot choose this score.',
        score_delta: 10,
      },
      {
        contextLoader: async () => 'Relevant memory',
        scorer: async (action, context) => {
          assert.equal('score_delta' in action, false);
          assert.equal(context, 'Relevant memory');
          return {
            score_delta: -2,
            reasoning: 'Independent evaluation.',
            dimensions: {},
          };
        },
      },
    );

    assert.equal(result.score_delta, -2);
  });

  it('defaults to privacy-safe scoring without calling a remote model', async () => {
    const result = await resolveActionScore({
      project_id: 'private-project',
      agent_id: 'codex',
      action_type: 'code',
      content: 'Private source code.',
    });

    assert.equal(result.score_status, 'private');
    assert.equal(result.score_delta, 0);
    assert.match(result.reasoning, /private project content/);
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
    const [discoveryResponse, openApiResponse] = await Promise.all([
      fetch(`${baseUrl}/.well-known/noosphere.json`),
      fetch(`${baseUrl}/openapi.json`),
    ]);
    const discovery = await discoveryResponse.json();
    const openApi = await openApiResponse.json();

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
});
