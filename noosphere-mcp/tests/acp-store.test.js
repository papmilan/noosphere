import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { ACP_PROTOCOL, ACP_SCHEMA_VERSION } from '../continuity/acp/project-state.js';
import { decodeEnvelope, digestEnvelope } from '../continuity/acp/wire.js';
import { observeRepository } from '../continuity/acp/git-state.js';
import { readState, writeState, writeStateIfCurrent } from '../continuity/acp/store.js';
import { writeSyncMetadata } from '../continuity/acp/sync-metadata.js';
import { RECONCILIATION_POLICY_VERSION, SYNC_PROTOCOL_VERSION, canonicalize, digestHeadSet } from '@noosphere/acp-protocol';
import { assertOwnerOnlyFile } from './file-security.js';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../continuity/index.js', import.meta.url));
const CREATED_AT = '2026-07-12T00:00:00.000Z';
const dirs = [];

async function makeRepo() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'noosphere-acp-store-'));
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
    goal: { project: 'Continuity.', current_objective: 'Persist ACP state.', success_conditions: ['State round-trips.'] },
    plan: [], completed_work: [], decisions: [], evidence: [], assumptions: [],
    rejected_approaches: [], unknowns: [], blockers: [], risks: [], conflicts: [],
    working_stance: { confidence: 'medium', momentum: 'progressing', risk_posture: 'verify-before-change', attention: [], dissatisfaction: [], successor_behavior: [] },
    next_actions: [{ id: 'n1', text: 'Wire the ACP CLI', status: 'planned', confidence: 'high', provenance: ['r1'], created_at: CREATED_AT, expires_at: null, repository_fingerprint: null, supersedes: [], priority: 1 }],
    references: [{ id: 'r1', kind: 'file', locator: 'continuity/index.js' }],
    extensions: {},
    ...overrides,
  };
  const digest = digestEnvelope(base);
  base.integrity.digest = digest;
  base.snapshot_id = `sha256:${digest}`;
  return base;
}

describe('ACP store and CLI', () => {
  let projectDir;

  before(async () => {
    projectDir = await makeRepo();
  });

  after(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('writes matching canonical JSON and Markdown', async () => {
    const observed = await observeRepository(projectDir);
    const state = decodeEnvelope(await signedEnvelope(observed), { clock: CREATED_AT }).state;
    await writeState(projectDir, state, { clock: CREATED_AT });
    const envelope = JSON.parse(await readFile(path.join(projectDir, '.noosphere', 'continuity.json'), 'utf8'));
    const kernel = await readFile(path.join(projectDir, '.noosphere', 'continuity.md'), 'utf8');
    assert.match(kernel, new RegExp(envelope.snapshot_id));
    const reread = await readState(projectDir, { clock: CREATED_AT });
    assert.equal(reread.ok, true);
    assert.equal(reread.state.envelope.goal.current_objective, 'Persist ACP state.');
  });

  it('imports a structured handoff through the CLI', async () => {
    const dir = await makeRepo();
    const observed = await observeRepository(dir);
    const candidateFile = path.join(dir, 'handoff.json');
    await writeFile(candidateFile, JSON.stringify(await signedEnvelope(observed)));
    const result = await execFileAsync('node', [CLI, 'handoff', '--file', candidateFile, '--path', dir]);
    assert.match(result.stdout, /ACP handoff stored/);
    const stored = JSON.parse(await readFile(path.join(dir, '.noosphere', 'continuity.json'), 'utf8'));
    assert.equal(stored.goal.current_objective, 'Persist ACP state.');
  });

  it('commits a configured handoff without reserving an upload when exact sync is disabled', async () => {
    const dir = await makeRepo();
    const observed = await observeRepository(dir);
    const candidateFile = path.join(dir, 'handoff.json');
    await writeFile(candidateFile, JSON.stringify(await signedEnvelope(observed)));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.join(dir, '.noosphere'), { recursive: true });
    await writeFile(path.join(dir, '.noosphere', 'config.json'), JSON.stringify({
      project_id: 'noosphere', relayer_url: 'http://127.0.0.1:1',
    }));
    await execFileAsync('node', [CLI, 'handoff', '--file', candidateFile, '--path', dir], {
      env: { ...process.env, NOOSPHERE_ACP_SYNC: 'false' },
    });
    assert.equal(JSON.parse(await readFile(path.join(dir, '.noosphere', 'continuity.json'), 'utf8')).goal.current_objective, 'Persist ACP state.');
    await assert.rejects(readFile(path.join(dir, '.noosphere', 'continuity-sync.json')), (error) => error.code === 'ENOENT');
  });

  it('durably queues an exact handoff while offline and retains HTTP 202 until success', async () => {
    const dir = await makeRepo();
    const observed = await observeRepository(dir);
    const candidateFile = path.join(dir, 'handoff.json');
    await writeFile(candidateFile, JSON.stringify(await signedEnvelope(observed)));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.join(dir, '.noosphere'), { recursive: true });
    await writeFile(path.join(dir, '.noosphere', 'config.json'), JSON.stringify({
      project_id: 'noosphere', relayer_url: 'http://127.0.0.1:1',
    }));

    const result = await execFileAsync('node', [CLI, 'handoff', '--file', candidateFile, '--path', dir], {
      env: { ...process.env, NOOSPHERE_ACP_RETRY_BASE_MS: '1' },
    });
    assert.match(result.stdout, /ACP handoff stored/);
    const stored = JSON.parse(await readFile(path.join(dir, '.noosphere', 'continuity.json'), 'utf8'));
    const metadata = JSON.parse(await readFile(path.join(dir, '.noosphere', 'continuity-sync.json'), 'utf8'));
    await assertOwnerOnlyFile(path.join(dir, '.noosphere', 'continuity-sync.json'));
    assert.equal(metadata.uploads[0].snapshot_id, stored.snapshot_id);
    assert.equal(metadata.uploads[0].attempts, 1);
    assert.equal(metadata.uploads[0].canonical_envelope, canonicalize(stored));
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /Persist ACP state|next_actions|integrity/);

    const stateB = decodeEnvelope(await signedEnvelope(observed, {
      goal: { project: 'Continuity.', current_objective: 'New local state B.', success_conditions: [] },
    }), { clock: CREATED_AT }).state;
    const writtenB = await writeState(dir, stateB, { clock: CREATED_AT });

    const indexId = `sha256:${'d'.repeat(64)}`;
    let posts = 0;
    let postedEnvelope;
    let remoteHeads = [];
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
        heads: remoteHeads, heads_digest: digestHeadSet(remoteHeads), complete: true,
      });
      if (request.method === 'POST' && request.url === '/v1/projects/noosphere/acp/snapshots') {
        posts += 1;
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const submission = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        postedEnvelope = submission.envelope;
        assert.equal(submission.expected_heads_digest, digestHeadSet(remoteHeads));
        if (posts === 1) {
          remoteHeads = [postedEnvelope.snapshot_id];
          return send(202, { pending: true, snapshot_id: postedEnvelope.snapshot_id });
        }
        return send(200, { created: false, deduplicated: true, snapshot_id: postedEnvelope.snapshot_id });
      }
      return send(404, { error: 'unexpected' });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      await writeFile(path.join(dir, '.noosphere', 'config.json'), JSON.stringify({
        project_id: 'noosphere', relayer_url: `http://127.0.0.1:${server.address().port}`,
      }));
      const env = { ...process.env, NOOSPHERE_HOME: path.join(dir, '.home'), NOOSPHERE_ACP_RETRY_BASE_MS: '1' };
      await execFileAsync('node', [CLI, 'activate', '--quiet', '--path', dir], { env });
      const pending = JSON.parse(await readFile(path.join(dir, '.noosphere', 'continuity-sync.json'), 'utf8'));
      assert.equal(pending.uploads.length, 1);
      assert.equal(pending.uploads[0].last_error, 'remote-pending');
      await execFileAsync('node', [CLI, 'activate', '--quiet', '--path', dir], { env });
      const retried = JSON.parse(await readFile(path.join(dir, '.noosphere', 'continuity-sync.json'), 'utf8'));
      assert.deepEqual(retried.uploads, []);
      assert.equal(posts, 2);
      assert.equal(postedEnvelope.snapshot_id, stored.snapshot_id);
      assert.equal(postedEnvelope.goal.current_objective, stored.goal.current_objective);
      assert.notEqual(postedEnvelope.snapshot_id, writtenB.envelope.snapshot_id);
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('applies queue backpressure before writing a handoff when the durable lineage bound is full', async () => {
    const dir = await makeRepo();
    const observed = await observeRepository(dir);
    const candidateFile = path.join(dir, 'handoff.json');
    await writeFile(candidateFile, JSON.stringify(await signedEnvelope(observed)));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.join(dir, '.noosphere'), { recursive: true });
    await writeFile(path.join(dir, '.noosphere', 'config.json'), JSON.stringify({
      project_id: 'noosphere', relayer_url: 'http://127.0.0.1:1',
    }));
    const uploads = Array.from({ length: 200 }, (_, index) => ({
      snapshot_id: `sha256:${index.toString(16).padStart(64, '0')}`,
      canonical_envelope: '{}', attempts: 0, next_attempt_at: new Date(0).toISOString(),
    }));
    await writeFile(path.join(dir, '.noosphere', 'continuity-sync.json'), `${JSON.stringify({ version: 1, confirmations: {}, uploads })}\n`, { mode: 0o600 });
    await assert.rejects(
      execFileAsync('node', [CLI, 'handoff', '--file', candidateFile, '--path', dir]),
      /upload-queue-limit/,
    );
    await assert.rejects(readFile(path.join(dir, '.noosphere', 'continuity.json')), (error) => error.code === 'ENOENT');
    assert.equal(JSON.parse(await readFile(path.join(dir, '.noosphere', 'continuity-sync.json'), 'utf8')).uploads.length, 200);
  });

  it('recovers both crash windows of a two-phase upload reservation without publishing failed local writes', async () => {
    const indexId = `sha256:${'8'.repeat(64)}`;
    let posts = 0;
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
        heads: [], heads_digest: digestHeadSet([]), complete: true,
      });
      if (request.method === 'POST') {
        posts += 1;
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const { envelope } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return send(201, { created: true, snapshot_id: envelope.snapshot_id });
      }
      return send(404, { error: 'unexpected' });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const failedRoot = await makeRepo();
      const failedObserved = await observeRepository(failedRoot);
      const failedEnvelope = await signedEnvelope(failedObserved);
      const { mkdir } = await import('node:fs/promises');
      await mkdir(path.join(failedRoot, '.noosphere'), { recursive: true });
      await writeFile(path.join(failedRoot, '.noosphere', 'config.json'), JSON.stringify({
        project_id: 'noosphere', relayer_url: `http://127.0.0.1:${server.address().port}`,
      }));
      await mkdir(path.join(failedRoot, '.noosphere', 'continuity.json'));
      const candidate = path.join(failedRoot, 'handoff.json');
      await writeFile(candidate, JSON.stringify(failedEnvelope));
      await assert.rejects(execFileAsync('node', [CLI, 'handoff', '--file', candidate, '--path', failedRoot]));
      const failedReservation = JSON.parse(await readFile(path.join(failedRoot, '.noosphere', 'continuity-sync.json'), 'utf8')).uploads[0];
      assert.equal(failedReservation.ready, false);
      await rm(path.join(failedRoot, '.noosphere', 'continuity.json'), { recursive: true });
      await writeFile(path.join(failedRoot, '.noosphere', 'continuity-upload.lock'), JSON.stringify({
        pid: 99999999, token: 'crashed-before-write', created_at: 0,
      }), { mode: 0o600 });
      await execFileAsync('node', [CLI, 'activate', '--quiet', '--path', failedRoot], {
        env: { ...process.env, NOOSPHERE_HOME: path.join(failedRoot, '.home') },
      });
      assert.equal(posts, 0);
      assert.deepEqual(JSON.parse(await readFile(path.join(failedRoot, '.noosphere', 'continuity-sync.json'), 'utf8')).uploads, []);

      const committedRoot = await makeRepo();
      const committedObserved = await observeRepository(committedRoot);
      const committedEnvelope = await signedEnvelope(committedObserved);
      const committedState = decodeEnvelope(committedEnvelope, { clock: CREATED_AT }).state;
      const committed = await writeState(committedRoot, committedState, { clock: CREATED_AT });
      await mkdir(path.join(committedRoot, '.noosphere'), { recursive: true });
      await writeFile(path.join(committedRoot, '.noosphere', 'config.json'), JSON.stringify({
        project_id: 'noosphere', relayer_url: `http://127.0.0.1:${server.address().port}`,
      }));
      await writeSyncMetadata(committedRoot, { version: 1, confirmations: {}, uploads: [{
        snapshot_id: committed.envelope.snapshot_id,
        canonical_envelope: canonicalize(committed.envelope),
        ready: false, attempts: 0, next_attempt_at: new Date(0).toISOString(),
      }] });
      await writeFile(path.join(committedRoot, '.noosphere', 'continuity-upload.lock'), JSON.stringify({
        pid: 99999999, token: 'crashed-before-ready', created_at: 0,
      }), { mode: 0o600 });
      await execFileAsync('node', [CLI, 'activate', '--quiet', '--path', committedRoot], {
        env: { ...process.env, NOOSPHERE_HOME: path.join(committedRoot, '.home') },
      });
      assert.equal(posts, 1);
      assert.deepEqual(JSON.parse(await readFile(path.join(committedRoot, '.noosphere', 'continuity-sync.json'), 'utf8')).uploads, []);
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('retains a corrupt queued envelope and performs no upload', async () => {
    const dir = await makeRepo();
    const observed = await observeRepository(dir);
    const candidateFile = path.join(dir, 'handoff.json');
    await writeFile(candidateFile, JSON.stringify(await signedEnvelope(observed)));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.join(dir, '.noosphere'), { recursive: true });
    await writeFile(path.join(dir, '.noosphere', 'config.json'), JSON.stringify({
      project_id: 'noosphere', relayer_url: 'http://127.0.0.1:1',
    }));
    await execFileAsync('node', [CLI, 'handoff', '--file', candidateFile, '--path', dir], {
      env: { ...process.env, NOOSPHERE_ACP_RETRY_BASE_MS: '1' },
    });
    const metadataPath = path.join(dir, '.noosphere', 'continuity-sync.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    metadata.uploads[0].canonical_envelope += ' ';
    metadata.uploads[0].next_attempt_at = new Date(0).toISOString();
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });

    const indexId = `sha256:${'e'.repeat(64)}`;
    let posts = 0;
    const server = http.createServer((request, response) => {
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
        heads: [], heads_digest: digestHeadSet([]), complete: true,
      });
      if (request.method === 'POST') posts += 1;
      return send(404, { error: 'unexpected' });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      await writeFile(path.join(dir, '.noosphere', 'config.json'), JSON.stringify({
        project_id: 'noosphere', relayer_url: `http://127.0.0.1:${server.address().port}`,
      }));
      await execFileAsync('node', [CLI, 'activate', '--quiet', '--path', dir], {
        env: { ...process.env, NOOSPHERE_HOME: path.join(dir, '.home') },
      });
      const retained = JSON.parse(await readFile(metadataPath, 'utf8')).uploads[0];
      assert.equal(posts, 0);
      assert.equal(retained.snapshot_id, metadata.uploads[0].snapshot_id);
      assert.equal(retained.last_error, 'upload-job-invalid');
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('returns a stable disabled action without reading or printing an envelope', async () => {
    const dir = await makeRepo();
    const result = await execFileAsync('node', [CLI, 'acp', 'state', 'sync', '--json', '--path', dir], {
      env: { ...process.env, NOOSPHERE_ACP_SYNC: 'false' },
    });
    assert.deepEqual(JSON.parse(result.stdout), {
      action: 'sync-disabled',
      actionable: false,
      confirmation_id: null,
      snapshot_id: null,
    });
    assert.doesNotMatch(result.stdout, /current_objective|integrity|next_actions/);
  });

  it('exposes exact sync and history as bounded JSON without semantic calls or envelope contents', async () => {
    const dir = await makeRepo();
    const observed = await observeRepository(dir);
    await writeState(dir, decodeEnvelope(await signedEnvelope(observed), { clock: CREATED_AT }).state, { clock: CREATED_AT });
    const indexId = `sha256:${'c'.repeat(64)}`;
    const requests = [];
    const server = http.createServer(async (request, response) => {
      requests.push(`${request.method} ${new URL(request.url, 'http://localhost').pathname}`);
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
        heads: [], heads_digest: digestHeadSet([]), complete: true,
      });
      if (request.url.startsWith('/v1/projects/noosphere/acp/history')) return send(200, { history: [] });
      if (request.method === 'POST' && request.url === '/v1/projects/noosphere/acp/snapshots') {
        for await (const _chunk of request) { /* drain */ }
        return send(201, { created: true });
      }
      return send(404, { error: 'unexpected' });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(path.join(dir, '.noosphere'), { recursive: true });
      await writeFile(path.join(dir, '.noosphere', 'config.json'), JSON.stringify({
        project_id: 'noosphere', relayer_url: `http://127.0.0.1:${server.address().port}`,
      }));
      const sync = await execFileAsync('node', [CLI, 'acp', 'state', 'sync', '--json', '--path', dir]);
      assert.equal(JSON.parse(sync.stdout).action, 'push-local');
      assert.doesNotMatch(sync.stdout, /current_objective|integrity|next_actions/);
      const history = await execFileAsync('node', [CLI, 'acp', 'state', 'history', '--json', '--limit', '2', '--path', dir]);
      assert.deepEqual(JSON.parse(history.stdout).history, []);
      assert.equal(requests.some((entry) => entry.includes('/recall') || entry.includes('/v1/actions')), false);
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('validates a freshly written state and rejects a tampered kernel', async () => {
    const dir = await makeRepo();
    const observed = await observeRepository(dir);
    const state = decodeEnvelope(await signedEnvelope(observed), { clock: CREATED_AT }).state;
    await writeState(dir, state, { clock: CREATED_AT });
    const ok = await execFileAsync('node', [CLI, 'acp', 'state', 'validate', '--path', dir]);
    assert.match(ok.stdout, /valid/);

    await writeFile(path.join(dir, '.noosphere', 'continuity.md'), 'tampered\n');
    await assert.rejects(execFileAsync('node', [CLI, 'acp', 'state', 'validate', '--path', dir]));
  });

  it('refuses to overwrite an unreadable continuity.json on handoff', async () => {
    const dir = await makeRepo();
    const observed = await observeRepository(dir);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.join(dir, '.noosphere'), { recursive: true });
    const corrupt = '{ this is not valid ACP json';
    await writeFile(path.join(dir, '.noosphere', 'continuity.json'), corrupt);
    const candidateFile = path.join(dir, 'handoff.json');
    await writeFile(candidateFile, JSON.stringify(await signedEnvelope(observed)));

    await assert.rejects(
      execFileAsync('node', [CLI, 'handoff', '--file', candidateFile, '--path', dir]),
      /unreadable/i,
    );
    // The corrupt file must be left exactly as-is, not overwritten.
    assert.equal(await readFile(path.join(dir, '.noosphere', 'continuity.json'), 'utf8'), corrupt);
  });

  it('compares explicit null/current snapshot IDs before writing', async () => {
    const dir = await makeRepo();
    const observed = await observeRepository(dir);
    const first = decodeEnvelope(await signedEnvelope(observed), { clock: CREATED_AT }).state;
    const initial = await writeStateIfCurrent(dir, first, null, { clock: CREATED_AT, compatibility: { status: 'exact', trustDowngrade: 0 } });
    await assert.rejects(writeStateIfCurrent(dir, first, null, { clock: CREATED_AT, compatibility: { status: 'exact', trustDowngrade: 0 } }), /confirmation-stale/);
    const secondEnvelope = await signedEnvelope(observed, { goal: { project: 'Continuity.', current_objective: 'Second state.', success_conditions: [] } });
    const second = decodeEnvelope(secondEnvelope, { clock: CREATED_AT }).state;
    await writeStateIfCurrent(dir, second, initial.envelope.snapshot_id, { clock: CREATED_AT, compatibility: { status: 'exact', trustDowngrade: 0 } });
    assert.equal((await readState(dir, { clock: CREATED_AT })).state.envelope.goal.current_objective, 'Second state.');
  });

  it('restores the prior JSON/Markdown pair when the second rename fails', async () => {
    const dir = await makeRepo();
    const observed = await observeRepository(dir);
    const first = decodeEnvelope(await signedEnvelope(observed), { clock: CREATED_AT }).state;
    const written = await writeStateIfCurrent(dir, first, null, { clock: CREATED_AT, compatibility: { status: 'exact', trustDowngrade: 0 } });
    const jsonPath = path.join(dir, '.noosphere', 'continuity.json');
    const mdPath = path.join(dir, '.noosphere', 'continuity.md');
    const before = [await readFile(jsonPath), await readFile(mdPath)];
    const second = decodeEnvelope(await signedEnvelope(observed, { phase: 'verification' }), { clock: CREATED_AT }).state;
    let renames = 0;
    await assert.rejects(writeStateIfCurrent(dir, second, written.envelope.snapshot_id, {
      clock: CREATED_AT,
      compatibility: { status: 'exact', trustDowngrade: 0 },
      rename: async (source, destination) => {
        renames += 1;
        if (renames === 2) throw new Error('injected-second-rename-failure');
        return rename(source, destination);
      },
    }), /injected-second-rename-failure/);
    assert.deepEqual(await readFile(jsonPath), before[0]);
    assert.deepEqual(await readFile(mdPath), before[1]);
  });

  it('recovers the durable pair transaction after restart at every recorded crash phase', async () => {
    for (const phase of ['prepared', 'committing', 'json-committed', 'committed']) {
      const dir = await makeRepo();
      const observed = await observeRepository(dir);
      const first = decodeEnvelope(await signedEnvelope(observed), { clock: CREATED_AT }).state;
      const written = await writeStateIfCurrent(dir, first, null, { clock: CREATED_AT, compatibility: { status: 'exact', trustDowngrade: 0 } });
      const second = decodeEnvelope(await signedEnvelope(observed, { phase: 'verification' }), { clock: CREATED_AT }).state;
      const crash = Object.assign(new Error(`crash-${phase}`), { simulatedCrash: true });
      await assert.rejects(writeStateIfCurrent(dir, second, written.envelope.snapshot_id, {
        clock: CREATED_AT,
        compatibility: { status: 'exact', trustDowngrade: 0 },
        phaseHook: async (current) => { if (current === phase) throw crash; },
      }), new RegExp(`crash-${phase}`));
      const recovered = await readState(dir, { clock: CREATED_AT });
      assert.equal(recovered.ok, true);
      assert.equal(recovered.state.envelope.snapshot_id, phase === 'committed' ? second.envelope.snapshot_id : written.envelope.snapshot_id);
      const artifacts = (await import('node:fs/promises').then(({ readdir }) => readdir(path.join(dir, '.noosphere'))))
        .filter((name) => name.includes('continuity-transaction') || name.includes('.txn-'));
      assert.deepEqual(artifacts, []);
    }
  });

  it('never reclaims an old state lock owned by a live PID', async () => {
    const dir = await makeRepo();
    await import('node:fs/promises').then(({ mkdir }) => mkdir(path.join(dir, '.noosphere'), { recursive: true }));
    const lock = path.join(dir, '.noosphere', '.continuity-state.lock');
    await writeFile(lock, JSON.stringify({ pid: process.pid, token: 'live', created_at: 0 }), { mode: 0o600 });
    const started = Date.now();
    setTimeout(() => { void rm(lock, { force: true }); }, 100);
    assert.equal(await readState(dir, { clock: CREATED_AT }), null);
    assert.equal(Date.now() - started >= 80, true);
  });
});
