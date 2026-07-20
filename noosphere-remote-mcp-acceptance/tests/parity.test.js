import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validCheckpoint } from '@noosphere/remote-mcp-contracts/tests/fixtures.js';
import { clock, startAcceptance } from './harness.js';
import { rawAdapter, sdkAdapter, structured } from './adapters.js';

const AT = '2026-07-20T10:00:00.000Z';

// Normalize ONLY intentionally nondeterministic values: server-generated
// project/session ids and timestamps. Error codes, warning codes, tool schemas,
// result shapes, and every behaviorally meaningful field are left intact.
function normalize(value, ids = new Map()) {
  if (Array.isArray(value)) return value.map((v) => normalize(v, ids));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalize(v, ids);
    return out;
  }
  if (typeof value === 'string') {
    if (/^(prj|ses)_[a-z0-9]+$/i.test(value)) {
      if (!ids.has(value)) ids.set(value, `<${value.slice(0, 3).toUpperCase()}#${ids.size}>`);
      return ids.get(value);
    }
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) return '<TS>';
    return value;
  }
  return value;
}

const errCode = (result) => (result && result.isError ? result.structuredContent.error.code : null);

// The common cross-client workflow. Runs entirely through the given adapter
// factory (SDK or raw JSON-RPC) against a dedicated server, and returns a
// semantic outcome for parity comparison.
async function runWorkflow(makeAdapter, h) {
  const owner = await h.token({ sub: 'parity-owner' });
  const a = makeAdapter(owner);
  const negotiated = await a.connect();

  const tools = await a.listTools();
  const toolNames = tools.map((t) => t.name).sort();
  const inputSchemas = Object.fromEntries(tools.map((t) => [t.name, t.inputSchema]));

  const project = structured(await a.callTool('create_project', { name: 'Bicycle Repair' })).project;
  const resolved = structured(await a.callTool('find_projects', { query: 'Bicycle Repair' }));
  const session = structured(await a.callTool('create_session', { project_id: project.id, source_client: 'acceptance-app' })).session;

  const c1 = validCheckpoint({ id: 'chk_p1', project_id: project.id, session_id: session.id, revision: 1, previous_checkpoint_id: null, current_status: 'Phase 1.', created_at: AT });
  const c2 = validCheckpoint({ id: 'chk_p2', project_id: project.id, session_id: session.id, revision: 2, previous_checkpoint_id: 'chk_p1', current_status: 'Phase 2.', created_at: AT });
  const save1 = structured(await a.callTool('save_checkpoint', { project_id: project.id, session_id: session.id, checkpoint: c1, idempotency_key: 'k1' }));
  const save2 = structured(await a.callTool('save_checkpoint', { project_id: project.id, session_id: session.id, checkpoint: c2, idempotency_key: 'k2' }));
  const replay = structured(await a.callTool('save_checkpoint', { project_id: project.id, session_id: session.id, checkpoint: c2, idempotency_key: 'k2' }));

  const listed = structured(await a.callTool('list_checkpoints', { project_id: project.id }));
  const got = structured(await a.callTool('get_checkpoint', { project_id: project.id, checkpoint_id: 'chk_p2' }));
  const latest = structured(await a.callTool('get_latest_checkpoint', { project_id: project.id }));
  const resumed = structured(await a.callTool('resume_project', { project_id: project.id }));

  await a.callTool('create_project', { name: 'Bicycle Maintenance' });
  const ambiguous = structured(await a.callTool('find_projects', { query: 'bicycle' }));
  const exact = structured(await a.callTool('find_projects', { query: 'Bicycle Maintenance' }));

  const invalidArgs = await a.callTool('get_project', { project_id: 'NOT A VALID ID' });

  // Owner isolation: a second identity of the same client kind cannot read it.
  const other = makeAdapter(await h.token({ sub: 'parity-other' }));
  await other.connect();
  const crossOwner = await other.callTool('get_project', { project_id: project.id });
  await other.close();
  await a.close();

  return normalize({
    negotiatedCapabilities: negotiated.capabilities,
    toolCount: tools.length,
    toolNames,
    inputSchemas,
    createProject: project,
    findResolved: resolved,
    createSession: { ...session },
    save1Dedup: save1.deduplicated,
    save2Dedup: save2.deduplicated,
    replayDedup: replay.deduplicated,
    listCount: listed.checkpoints.length,
    listTrust: listed.content_trust,
    getCheckpointStatus: got.checkpoint.current_status,
    latestTrust: latest.content_trust,
    resumeHead: resumed.latest_checkpoint.current_status,
    resumeFreshness: resumed.freshness,
    resumeWarnings: resumed.warnings,
    resumeTrust: resumed.content_trust,
    ambiguousResult: ambiguous.result,
    ambiguousCount: ambiguous.candidates.length,
    exactResult: exact.result,
    invalidArgsCode: errCode(invalidArgs),
    crossOwnerCode: errCode(crossOwner),
  });
}

describe('Cross-client semantic parity: SDK client vs raw JSON-RPC client', () => {
  it('produces identical semantic outcomes across both independent client transports', async () => {
    const outcomes = {};
    for (const factory of [sdkAdapter, rawAdapter]) {
      const h = await startAcceptance({ now: clock(AT) });
      const make = (token) => factory({ mcpUrl: h.mcpUrl, token });
      try {
        outcomes[factory === sdkAdapter ? 'sdk' : 'raw'] = await runWorkflow(make, h);
      } finally {
        await h.close();
      }
    }

    // Sanity: each path actually exercised the full tool surface and semantics.
    assert.equal(outcomes.sdk.toolCount, 15);
    assert.deepEqual(outcomes.sdk.toolNames, outcomes.sdk.toolNames.slice().sort());
    assert.equal(outcomes.sdk.save1Dedup, false);
    assert.equal(outcomes.sdk.replayDedup, true);
    assert.equal(outcomes.sdk.ambiguousResult, 'ambiguous');
    assert.equal(outcomes.sdk.exactResult, 'resolved');
    assert.equal(outcomes.sdk.invalidArgsCode, 'invalid-argument');
    assert.equal(outcomes.sdk.crossOwnerCode, 'not-found');
    assert.equal(outcomes.sdk.resumeHead, 'Phase 2.');
    assert.equal(outcomes.sdk.latestTrust, 'untrusted-persisted-data');

    // The parity assertion: both transports yield the same semantics.
    assert.deepEqual(outcomes.raw, outcomes.sdk);
  });

  it('advertises identical tool names and input schemas on both transports', async () => {
    const h = await startAcceptance({ now: clock(AT) });
    try {
      const token = await h.token({ sub: 'schemas' });
      const sdk = sdkAdapter({ mcpUrl: h.mcpUrl, token });
      const raw = rawAdapter({ mcpUrl: h.mcpUrl, token });
      await sdk.connect();
      await raw.connect();
      const sdkTools = (await sdk.listTools()).sort((x, y) => x.name.localeCompare(y.name));
      const rawTools = (await raw.listTools()).sort((x, y) => x.name.localeCompare(y.name));
      assert.equal(rawTools.length, 15);
      assert.deepEqual(rawTools.map((t) => t.name), sdkTools.map((t) => t.name));
      assert.deepEqual(rawTools.map((t) => t.inputSchema), sdkTools.map((t) => t.inputSchema));
      await sdk.close();
      await raw.close();
    } finally {
      await h.close();
    }
  });
});
