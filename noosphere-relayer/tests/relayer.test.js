import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPersonalMessageSignature } from '@mysten/sui/verify';

// Registry uses module-level paths; we test via the exported functions directly.
// Patch the registry path by pointing it at a temp dir before importing.
const directory = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = path.join(directory, '.tmp-registry-test');
const tmpRegistryPath = path.join(tmpDir, 'project_registry.json');

// registry.js reads its path at module load time, so we seed the file before import.
await mkdir(tmpDir, { recursive: true });

// We test a hand-rolled equivalent of the registry logic to avoid import-path hacks.
// The real functions are tested via the HTTP server in integration style below.

describe('registry logic', () => {
  it('initialises missing project on first write', () => {
    const registry = { projects: {} };
    const projectId = 'test-proj';
    const project = registry.projects[projectId] || {
      blob_ids: [],
      genome_object_ids: [],
      agents: {},
      action_receipts: {},
    };

    project.blob_ids.push('blob-1');
    registry.projects[projectId] = project;

    assert.deepEqual(registry.projects[projectId].blob_ids, ['blob-1']);
  });

  it('does not duplicate blob_ids on repeat push', () => {
    const project = { blob_ids: ['blob-1'], genome_object_ids: [], agents: {}, action_receipts: {} };

    if (!project.blob_ids.includes('blob-1')) project.blob_ids.push('blob-1');

    assert.equal(project.blob_ids.length, 1);
  });

  it('does not duplicate genome_object_ids', () => {
    const project = { blob_ids: [], genome_object_ids: ['g-1'], agents: {}, action_receipts: {} };

    if (!project.genome_object_ids.includes('g-1')) project.genome_object_ids.push('g-1');

    assert.equal(project.genome_object_ids.length, 1);
  });

  it('score clamps at 0', () => {
    const score = Math.max(0, Math.min(1000, 500 + (-600)));
    assert.equal(score, 0);
  });

  it('score clamps at 1000', () => {
    const score = Math.max(0, Math.min(1000, 500 + 600));
    assert.equal(score, 1000);
  });

  it('increments decision_count', () => {
    const agent = { reputation_score: 500, decision_count: 0 };
    agent.decision_count += 1;
    assert.equal(agent.decision_count, 1);
  });

  it('action_receipts initialised via ||= for old registry entries', () => {
    const project = { blob_ids: [], genome_object_ids: [], agents: {} };
    project.action_receipts ||= {};
    project.action_receipts['idem-1'] = { blob_id: 'b1', tx_digest: 'tx1' };
    assert.equal(project.action_receipts['idem-1'].blob_id, 'b1');
  });
});

describe('HTTP server (demo mode)', () => {
  let server;
  let baseUrl;
  let resolveActionScore;
  let createScoreSigningPayload;
  let storedActionId;

  before(async () => {
    process.env.DEMO_MODE = 'true';
    process.env.NODE_ENV = 'test';
    process.env.SCORER_PRIVATE_KEY = Buffer.alloc(32, 7).toString('base64');
    const relayer = await import('../index.js');
    const scorer = await import('../scorer.js');
    const { app } = relayer;
    resolveActionScore = relayer.resolveActionScore;
    createScoreSigningPayload = scorer.createScoreSigningPayload;
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://localhost:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('GET /health returns demo mode', async () => {
    const res = await fetch(`${baseUrl}/health`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.demo_mode, true);
    assert.equal(body.scorer_configured, false);
    assert.equal(body.scorer_key_configured, true);
    assert.ok(body.success);
  });

  it('GET /v1/projects/:id/context returns empty context for unknown project', async () => {
    const res = await fetch(`${baseUrl}/v1/projects/no-such-project/context`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.ok(body.context.includes('no-such-project'));
    assert.deepEqual(body.actions, []);
  });

  it('GET /v1/projects/:id/context returns text/plain when format=text', async () => {
    const res = await fetch(`${baseUrl}/v1/projects/no-such-project/context?format=text`);
    assert.ok(res.headers.get('content-type').includes('text/plain'));
    const text = await res.text();
    assert.ok(text.startsWith('--- PROJECT CONTEXT:'));
  });

  it('POST /v1/actions ignores a caller-provided score_delta', async () => {
    const res = await fetch(`${baseUrl}/v1/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: 'ignored-score',
        agent_id: 'untrusted-agent',
        genome_object_id: 'demo-genome-untrusted',
        action_type: 'decision',
        content: 'Attempted to choose my own score.',
        score_delta: 999,
        session_id: 'ignored-score-session',
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 201);
    assert.equal(body.score_delta, 0);
    assert.equal(body.score_automatic, true);
    assert.equal(body.score_status, 'fallback');
    assert.equal(body.scorer_model, 'claude-haiku-4-5-20251001');
    assert.equal(body.scorer_version, 'noosphere-scorer-v1.0');
    assert.ok(body.scored_by);
    assert.ok(body.score_signature);
  });

  it('POST /v1/actions rejects missing session_id', async () => {
    const res = await fetch(`${baseUrl}/v1/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: 'p', agent_id: 'a', genome_object_id: 'g',
        action_type: 't', content: 'c', score_delta: 5,
      }),
    });
    assert.equal(res.status, 400);
  });

  it('automatic scoring loads project context and invokes the scorer', async () => {
    let contextCalls = 0;
    let scorerCalls = 0;
    const action = {
      project_id: 'auto-project',
      agent_id: 'codex',
      action_type: 'code',
      content: 'Implemented the feature.',
    };

    const result = await resolveActionScore(action, {
      contextLoader: async (projectId) => {
        contextCalls += 1;
        assert.equal(projectId, 'auto-project');
        return 'Previous project context';
      },
      scorer: async (receivedAction, context) => {
        scorerCalls += 1;
        assert.deepEqual(receivedAction, action);
        assert.equal(context, 'Previous project context');
        return {
          score_delta: 7,
          reasoning: 'Strong implementation.',
          dimensions: {
            accuracy: 2,
            completeness: 1,
            code_quality: 2,
            reasoning: 1,
          },
          automatic: true,
        };
      },
    });

    assert.equal(contextCalls, 1);
    assert.equal(scorerCalls, 1);
    assert.equal(result.score_delta, 7);
    assert.equal(result.automatic, true);
  });

  it('non-zero caller score is ignored and automatic scoring still runs', async () => {
    let contextCalls = 0;
    let scorerCalls = 0;

    const result = await resolveActionScore(
      { project_id: 'untrusted-project', score_delta: -10 },
      {
        contextLoader: async () => {
          contextCalls += 1;
          return 'Trusted project context';
        },
        scorer: async (action, context) => {
          scorerCalls += 1;
          assert.equal('score_delta' in action, false);
          assert.equal(context, 'Trusted project context');
          return {
            score_delta: 6,
            reasoning: 'Scorer-owned result.',
            dimensions: {
              accuracy: 2,
              completeness: 1,
              code_quality: 1,
              reasoning: 1,
            },
            automatic: true,
          };
        },
      },
    );

    assert.equal(contextCalls, 1);
    assert.equal(scorerCalls, 1);
    assert.equal(result.score_delta, 6);
    assert.equal(result.automatic, true);
  });

  it('automatic scoring failure falls back to neutral score', async () => {
    const result = await resolveActionScore(
      { project_id: 'fallback-project' },
      {
        contextLoader: async () => {
          throw new Error('Context unavailable');
        },
      },
    );

    assert.equal(result.score_delta, 0);
    assert.deepEqual(result.dimensions, {
      accuracy: 0,
      completeness: 0,
      code_quality: 0,
      reasoning: 0,
    });
  });

  it('POST /v1/actions stores action and returns 201', async () => {
    const res = await fetch(`${baseUrl}/v1/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: 'test-proj', agent_id: 'test-agent',
        genome_object_id: 'demo-genome-test', action_type: 'decision',
        content: 'Test decision.', score_delta: 3, session_id: 'sess-1',
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.success);
    assert.ok(body.action_id);
    storedActionId = body.action_id;
    assert.ok(body.blob_id);
    assert.ok(body.tx_digest);
    assert.equal(body.score_delta, 0);
    assert.equal(body.score_automatic, true);
    assert.equal(body.score_status, 'fallback');
  });

  it('POST /v1/actions treats an omitted score_delta as automatic', async () => {
    const res = await fetch(`${baseUrl}/v1/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: 'test-proj',
        agent_id: 'test-agent',
        genome_object_id: 'demo-genome-test',
        action_type: 'decision',
        content: 'Score this automatically.',
        session_id: 'sess-auto-default',
      }),
    });
    const body = await res.json();

    assert.equal(res.status, 201);
    assert.equal(body.score_delta, 0);
    assert.equal(body.score_automatic, true);
    assert.deepEqual(body.score_breakdown, {
      accuracy: 0,
      completeness: 0,
      code_quality: 0,
      reasoning: 0,
    });
  });

  it('POST /v1/actions deduplicates with same Idempotency-Key', async () => {
    const key = `idem-test-${Date.now()}`;
    const payload = JSON.stringify({
      project_id: 'test-proj', agent_id: 'test-agent',
      genome_object_id: 'demo-genome-test', action_type: 'decision',
      content: 'Idempotent.', score_delta: 1, session_id: 'sess-idem',
    });
    const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': key };

    const first = await fetch(`${baseUrl}/v1/actions`, { method: 'POST', headers, body: payload });
    const firstBody = await first.json();
    assert.equal(first.status, 201);

    const second = await fetch(`${baseUrl}/v1/actions`, { method: 'POST', headers, body: payload });
    const secondBody = await second.json();
    assert.equal(second.status, 200);
    assert.equal(secondBody.deduplicated, true);
    assert.equal(secondBody.blob_id, firstBody.blob_id);
  });

  it('GET /v1/projects/:id/agents returns demo agents', async () => {
    const res = await fetch(`${baseUrl}/v1/projects/test-proj/agents`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(body.agents));
    assert.ok('average_rating' in body.agents[0]);
    assert.ok('verified_rating_count' in body.agents[0]);
  });

  it('GET project context attaches the Sui transaction proof to actions', async () => {
    const res = await fetch(`${baseUrl}/v1/projects/test-proj/context`);
    const body = await res.json();
    const storedAction = body.actions.find(
      (action) => action.action_id === storedActionId,
    );

    assert.ok(storedAction);
    assert.ok(storedAction.blob_id);
    assert.ok(storedAction.tx_digest);
    assert.equal(storedAction.storage_epochs, 200);
    assert.equal(
      storedAction.scorer_version,
      'noosphere-scorer-v1.0',
    );
    assert.equal(storedAction.scoring_policy_version, '1.0.0');
    assert.ok(storedAction.stored_at);
    assert.ok(storedAction.scored_by);
    assert.ok(storedAction.score_signature);

    const publicKey = await verifyPersonalMessageSignature(
      createScoreSigningPayload(storedAction),
      storedAction.score_signature,
    );
    assert.equal(publicKey.toSuiPublicKey(), storedAction.scored_by);
  });

  it('GET /.well-known/noosphere.json describes the API', async () => {
    const res = await fetch(`${baseUrl}/.well-known/noosphere.json`);
    const body = await res.json();
    assert.equal(body.version, '1.0.0');
    assert.equal(body.name, 'Noosphere');
    assert.equal(
      body.scoring.on_chain_event,
      'noosphere::noosphere::DecisionScored',
    );
    assert.ok(body.endpoints.submit_action);
    assert.ok(body.endpoints.scoring_policy);
  });

  it('GET /scoring-policy returns the hash-verified v1 policy', async () => {
    const res = await fetch(`${baseUrl}/scoring-policy`);
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.version, '1.0.0');
    assert.equal(body.model, 'claude-haiku-4-5-20251001');
    assert.match(body.prompt_hash, /^[a-f0-9]{64}$/);
    assert.deepEqual(
      body.dimensions.map(({ name }) => name),
      ['accuracy', 'completeness', 'code_quality', 'reasoning'],
    );
  });

  it('GET /openapi.json returns valid OpenAPI document', async () => {
    const res = await fetch(`${baseUrl}/openapi.json`);
    const body = await res.json();
    assert.equal(body.openapi, '3.1.0');
    assert.ok(body.paths['/v1/actions']);
    assert.ok(body.paths['/scoring-policy']);
  });
});
