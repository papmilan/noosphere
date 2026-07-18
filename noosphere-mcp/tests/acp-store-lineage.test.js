import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { ACP_PROTOCOL, ACP_SCHEMA_VERSION } from '../continuity/acp/project-state.js';
import { decodeEnvelope, digestEnvelope } from '../continuity/acp/wire.js';
import { observeRepository } from '../continuity/acp/git-state.js';
import { writeSyncMetadata } from '../continuity/acp/sync-metadata.js';
import {
  RECONCILIATION_POLICY_VERSION,
  SYNC_PROTOCOL_VERSION,
  digestHeadSet,
} from '@noosphere/acp-protocol';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../continuity/index.js', import.meta.url));
const CREATED_AT = '2026-07-12T00:00:00.000Z';
const dirs = [];

async function makeRepo() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'noosphere-acp-store-lineage-'));
  dirs.push(dir);
  await execFileAsync('git', ['init'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await writeFile(path.join(dir, 'README.md'), `# ${path.basename(dir)}\n`);
  await execFileAsync('git', ['add', '.'], { cwd: dir });
  await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: dir });
  return dir;
}

async function signedEnvelope(observed, overrides = {}) {
  const base = {
    protocol: ACP_PROTOCOL,
    schema_version: ACP_SCHEMA_VERSION,
    snapshot_id: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    parent_snapshot_id: null,
    created_at: CREATED_AT,
    expires_at: null,
    origin: { agent_id: 'codex', client: 'codex-desktop', session_id: null },
    integrity: {
      algorithm: 'sha256',
      digest: '0000000000000000000000000000000000000000000000000000000000000000',
      signature: { status: 'unsigned', algorithm: null, key_id: null, value: null },
    },
    permission_scope: 'project',
    trust: { level: 'local-unverified', reasons: ['unsigned local envelope'] },
    repository: {
      project_id: 'noosphere',
      root_identity: observed.root_identity,
      head: observed.head,
      branch: observed.branch,
      merge_base: null,
      dirty: observed.dirty,
      workspace_fingerprint: observed.workspace_fingerprint,
    },
    phase: 'implementation',
    goal: {
      project: 'Continuity.',
      current_objective: 'Persist ACP state.',
      success_conditions: ['State round-trips.'],
    },
    plan: [], completed_work: [], decisions: [], evidence: [], assumptions: [],
    rejected_approaches: [], unknowns: [], blockers: [], risks: [], conflicts: [],
    working_stance: {
      confidence: 'medium', momentum: 'progressing', risk_posture: 'verify-before-change',
      attention: [], dissatisfaction: [], successor_behavior: [],
    },
    next_actions: [{
      id: 'n1', text: 'Wire the ACP CLI', status: 'planned', confidence: 'high',
      provenance: ['r1'], created_at: CREATED_AT, expires_at: null,
      repository_fingerprint: null, supersedes: [], priority: 1,
    }],
    references: [{ id: 'r1', kind: 'file', locator: 'continuity/index.js' }],
    extensions: {},
    ...overrides,
  };
  const digest = digestEnvelope(base);
  base.integrity.digest = digest;
  base.snapshot_id = `sha256:${digest}`;
  return base;
}

describe('ACP store durable lineage', () => {
  after(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('preserves more than 16 offline handoffs across restart and eventually uploads actionable lineage', async () => {
    const dir = await makeRepo();
    const observed = await observeRepository(dir);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.join(dir, '.noosphere'), { recursive: true });
    await writeFile(path.join(dir, '.noosphere', 'config.json'), JSON.stringify({
      project_id: 'noosphere', relayer_url: 'http://127.0.0.1:1',
    }));
    const env = { ...process.env, NOOSPHERE_ACP_RETRY_BASE_MS: '1' };
    let parentSnapshotId = null;
    for (let index = 0; index < 17; index += 1) {
      const candidateFile = path.join(dir, `handoff-${index}.json`);
      await writeFile(candidateFile, JSON.stringify(await signedEnvelope(observed, {
        parent_snapshot_id: parentSnapshotId,
        next_actions: [{
          id: `offline-${index}`, text: `Offline action ${index}`, status: 'planned', confidence: 'high',
          provenance: ['r1'], created_at: CREATED_AT, expires_at: null,
          repository_fingerprint: null, supersedes: [], priority: index + 1,
        }],
      })));
      await execFileAsync('node', [CLI, 'handoff', '--file', candidateFile, '--path', dir], { env });
      parentSnapshotId = JSON.parse(await readFile(path.join(dir, '.noosphere', 'continuity.json'), 'utf8')).snapshot_id;
    }
    const queuedMetadata = JSON.parse(await readFile(path.join(dir, '.noosphere', 'continuity-sync.json'), 'utf8'));
    const queued = queuedMetadata.uploads;
    assert.equal(queued.length, 17);
    assert.equal(new Set(queued.map(({ snapshot_id }) => snapshot_id)).size, 17);
    const queuedEnvelopes = queued.map(({ canonical_envelope }) => JSON.parse(canonical_envelope));
    assert.equal(queuedEnvelopes[0].parent_snapshot_id, null);
    for (let index = 1; index < queuedEnvelopes.length; index += 1) {
      assert.equal(queuedEnvelopes[index].parent_snapshot_id, queuedEnvelopes[index - 1].snapshot_id);
    }
    queuedMetadata.uploads[0].next_attempt_at = '2999-01-01T00:00:00.000Z';
    for (const job of queuedMetadata.uploads.slice(1)) job.next_attempt_at = new Date(0).toISOString();
    await writeSyncMetadata(dir, queuedMetadata);

    const indexId = `sha256:${'9'.repeat(64)}`;
    const posted = [];
    const indexed = new Map();
    let heads = [];
    const server = http.createServer(async (request, response) => {
      const send = (status, body) => {
        response.writeHead(status, { 'content-type': 'application/json', 'x-relayer-index-id': indexId });
        response.end(JSON.stringify(body));
      };
      if (request.url === '/v1/acp/capabilities') return send(200, {
        exact_bytes_durable: true, index_durable: true, relayer_index_id: indexId,
        sync_protocol_version: SYNC_PROTOCOL_VERSION,
        reconciliation_policy_version: RECONCILIATION_POLICY_VERSION,
      });
      if (request.url === '/v1/projects/noosphere/acp/heads') return send(200, {
        heads, heads_digest: digestHeadSet(heads), complete: true,
      });
      if (request.method === 'POST' && request.url === '/v1/projects/noosphere/acp/snapshots') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const { envelope, expected_heads_digest: expected } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        assert.equal(expected, digestHeadSet(heads));
        posted.push(envelope);
        indexed.set(envelope.snapshot_id, envelope);
        const parentIds = new Set([...indexed.values()].map(({ parent_snapshot_id: parent }) => parent).filter(Boolean));
        heads = [...indexed.keys()].filter((snapshotId) => !parentIds.has(snapshotId)).sort();
        return send(201, { created: true, snapshot_id: envelope.snapshot_id, heads });
      }
      return send(404, { error: 'unexpected' });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      await writeFile(path.join(dir, '.noosphere', 'config.json'), JSON.stringify({
        project_id: 'noosphere', relayer_url: `http://127.0.0.1:${server.address().port}`,
      }));
      await execFileAsync('node', [CLI, 'activate', '--quiet', '--path', dir], {
        env: { ...env, NOOSPHERE_HOME: path.join(dir, '.home') },
      });
      const deferred = JSON.parse(await readFile(path.join(dir, '.noosphere', 'continuity-sync.json'), 'utf8'));
      assert.deepEqual(deferred.uploads.map(({ snapshot_id: snapshotId }) => snapshotId), [queued[0].snapshot_id]);
      deferred.uploads[0].next_attempt_at = new Date(0).toISOString();
      await writeSyncMetadata(dir, deferred);
      await execFileAsync('node', [CLI, 'activate', '--quiet', '--path', dir], {
        env: { ...env, NOOSPHERE_HOME: path.join(dir, '.home') },
      });
      const restarted = JSON.parse(await readFile(path.join(dir, '.noosphere', 'continuity-sync.json'), 'utf8'));
      assert.deepEqual(restarted.uploads, []);
      assert.equal(posted.length, 17);
      assert.deepEqual(posted.map(({ snapshot_id }) => snapshot_id), [
        ...queued.slice(1).map(({ snapshot_id }) => snapshot_id),
        queued[0].snapshot_id,
      ]);
      const actionable = indexed.get(queued.at(-1).snapshot_id);
      assert.equal(actionable.next_actions.some(({ status }) => status === 'planned'), true);
      assert.equal(decodeEnvelope(actionable, { clock: CREATED_AT }).ok, true);
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
