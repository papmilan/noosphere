import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { validCheckpoint } from '@noosphere/remote-mcp-contracts/tests/fixtures.js';
import { clock, startHttpClient, startStdioClient, structured } from './harness.js';

const AT = '2026-07-20T10:00:00.000Z';

// Normalize ONLY the intentionally instance-specific values: server-generated
// project/session ids and timestamps. Everything behaviorally meaningful —
// error codes, warning codes, trust labels, dedup flags, tool schemas, result
// shapes, ordering, freshness — is left intact for the comparison.
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

// Drive one identical semantic workflow through an SDK client, whatever the
// transport underneath it. Returns a normalized outcome for parity comparison:
// init/capabilities, tool discovery + schemas, project create/resolve, session,
// two chained checkpoint writes, listing/retrieval, resume, idempotent replay,
// conflicting idempotency reuse, ambiguity/exact search, cursor pagination, invalid
// arguments, trust labels, warning/freshness.
async function runWorkflow(session) {
  const { client } = session;
  const call = (name, args) => client.callTool({ name, arguments: args });

  const capabilities = client.getServerCapabilities() ?? null;
  const tools = (await client.listTools()).tools;
  const toolNames = tools.map((t) => t.name).sort();
  const inputSchemas = Object.fromEntries(tools.map((t) => [t.name, t.inputSchema]));

  const project = structured(await call('create_project', { name: 'Bicycle Repair', aliases: ['Two-Wheeler Service'] })).project;
  const resolvedByName = structured(await call('find_projects', { query: 'bicycle repair' }));
  const resolvedByAlias = structured(await call('find_projects', { query: 'two-wheeler service' }));
  const session1 = structured(await call('create_session', { project_id: project.id, source_client: 'acceptance-app' })).session;

  const c1 = validCheckpoint({ id: 'chk_p1', project_id: project.id, session_id: session1.id, revision: 1, previous_checkpoint_id: null, current_status: 'Phase 1.', created_at: AT });
  const c2 = validCheckpoint({ id: 'chk_p2', project_id: project.id, session_id: session1.id, revision: 2, previous_checkpoint_id: 'chk_p1', current_status: 'Phase 2.', created_at: AT });
  const save1 = structured(await call('save_checkpoint', { project_id: project.id, session_id: session1.id, checkpoint: c1, idempotency_key: 'k1' }));
  const save2 = structured(await call('save_checkpoint', { project_id: project.id, session_id: session1.id, checkpoint: c2, idempotency_key: 'k2' }));
  const replay = structured(await call('save_checkpoint', { project_id: project.id, session_id: session1.id, checkpoint: c2, idempotency_key: 'k2' }));
  const conflict = await call('save_checkpoint', { project_id: project.id, session_id: session1.id, checkpoint: { ...c2, current_status: 'Different.' }, idempotency_key: 'k2' });

  const listed = structured(await call('list_checkpoints', { project_id: project.id }));
  const got = structured(await call('get_checkpoint', { project_id: project.id, checkpoint_id: 'chk_p2' }));
  const latest = structured(await call('get_latest_checkpoint', { project_id: project.id }));
  const resumed = structured(await call('resume_project', { project_id: project.id }));
  const summary = structured(await call('get_project_summary', { project_id: project.id }));

  // Ambiguity + exact + none.
  await call('create_project', { name: 'Bicycle Maintenance' });
  const ambiguous = structured(await call('find_projects', { query: 'bicycle' }));
  const exact = structured(await call('find_projects', { query: 'Bicycle Maintenance' }));
  const none = structured(await call('find_projects', { query: 'no-such-thing-xyz' }));

  // Cursor pagination across a multi-page project list.
  for (const name of ['Alpha', 'Bravo', 'Charlie']) await call('create_project', { name: `${name} Project` });
  const page1 = structured(await call('list_projects', { limit: 2 }));
  const page2 = structured(await call('list_projects', { limit: 2, cursor: page1.next_cursor }));
  const tampered = await call('list_projects', { limit: 2, cursor: `${page1.next_cursor}x` });

  const invalidArgs = await call('get_project', { project_id: 'NOT A VALID ID' });
  const crossMissing = await call('get_checkpoint', { project_id: project.id, checkpoint_id: 'chk_absent' });

  return normalize({
    capabilities,
    toolCount: tools.length,
    toolNames,
    inputSchemas,
    createProject: project,
    resolvedByNameResult: resolvedByName.result,
    resolvedByAliasResult: resolvedByAlias.result,
    save1Dedup: save1.deduplicated,
    save2Dedup: save2.deduplicated,
    replayDedup: replay.deduplicated,
    conflictCode: errCode(conflict),
    listCount: listed.checkpoints.length,
    listTrust: listed.content_trust,
    getStatus: got.checkpoint.current_status,
    latestTrust: latest.content_trust,
    latestId: latest.checkpoint.id,
    resumeHead: resumed.latest_checkpoint.current_status,
    resumeFreshness: resumed.freshness,
    resumeWarnings: resumed.warnings,
    resumeTrust: resumed.content_trust,
    summaryCount: summary.summary.checkpoint_count,
    summaryTrust: summary.content_trust,
    ambiguousResult: ambiguous.result,
    ambiguousCount: ambiguous.candidates.length,
    exactResult: exact.result,
    noneResult: none.result,
    page1Count: page1.projects.length,
    page1HasCursor: page1.next_cursor !== null,
    page2Count: page2.projects.length,
    tamperedCode: errCode(tampered),
    invalidArgsCode: errCode(invalidArgs),
    crossMissingCode: errCode(crossMissing),
  });
}

describe('Transport parity: Local STDIO client vs Remote HTTP client', () => {
  let stdio, http;
  before(async () => {
    // Both transports run on the same fixed instant, so freshness/warnings are
    // a function of transport behavior only, not of two different wall clocks.
    stdio = await startStdioClient({ nowIso: AT });
    http = await startHttpClient({ now: clock(AT) });
  });
  after(async () => {
    if (stdio) await stdio.close();
    if (http) await http.close();
  });

  it('produces identical semantic outcomes over STDIO and Streamable HTTP', async () => {
    const stdioOutcome = await runWorkflow(stdio);
    const httpOutcome = await runWorkflow(http);

    // Sanity: each transport actually exercised the full surface and semantics.
    assert.equal(stdioOutcome.toolCount, 16);
    assert.equal(stdioOutcome.save1Dedup, false);
    assert.equal(stdioOutcome.replayDedup, true);
    assert.equal(stdioOutcome.conflictCode, 'idempotency-conflict');
    assert.equal(stdioOutcome.resumeHead, 'Phase 2.');
    assert.equal(stdioOutcome.latestTrust, 'untrusted-persisted-data');
    assert.equal(stdioOutcome.ambiguousResult, 'ambiguous');
    assert.equal(stdioOutcome.exactResult, 'resolved');
    assert.equal(stdioOutcome.noneResult, 'none');
    assert.equal(stdioOutcome.page1HasCursor, true);
    assert.equal(stdioOutcome.tamperedCode, 'invalid-argument');
    assert.equal(stdioOutcome.invalidArgsCode, 'invalid-argument');

    // The parity assertion: both transports yield the same semantics.
    assert.deepEqual(stdioOutcome, httpOutcome);
  });

  it('advertises identical tool names and input schemas on both transports', async () => {
    const stdioTools = (await stdio.client.listTools()).tools.sort((a, b) => a.name.localeCompare(b.name));
    const httpTools = (await http.client.listTools()).tools.sort((a, b) => a.name.localeCompare(b.name));
    assert.equal(stdioTools.length, 16);
    assert.deepEqual(stdioTools.map((t) => t.name), httpTools.map((t) => t.name));
    assert.deepEqual(stdioTools.map((t) => t.inputSchema), httpTools.map((t) => t.inputSchema));
  });
});
