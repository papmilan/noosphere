import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  ACP_LIMITS, RECONCILIATION_POLICY_VERSION, SYNC_PROTOCOL_VERSION, canonicalize, digestHeadSet, encodeEnvelope,
} from '@noosphere/acp-protocol';
import {
  applyRemoteConfirmation,
  discoverRemoteState,
  issueRemoteConfirmation,
  listQuarantine,
  listRemoteHistory,
} from '../continuity/acp/sync.js';
import { digestRepositoryObservation, issueConfirmation } from '../continuity/acp/sync-metadata.js';

const dirs = [];
const NOW = Date.parse('2026-07-13T00:00:00.000Z');
const id = (char) => `sha256:${char.repeat(64)}`;
const REPOSITORY_DIGEST = digestRepositoryObservation(observed());
after(async () => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));
async function temp() { const dir = await mkdtemp(path.join(os.tmpdir(), 'noosphere-sync-')); dirs.push(dir); return dir; }

function envelope({ parent = null, objective = 'remote', expiresAt = null } = {}) {
  return encodeEnvelope({ envelope: {
    protocol: 'acp.project-state-envelope', schema_version: '1.0.0', snapshot_id: id('0'), parent_snapshot_id: parent,
    created_at: '2026-07-12T00:00:00.000Z', expires_at: expiresAt,
    origin: { agent_id: 'remote', client: 'test', session_id: null },
    integrity: { algorithm: 'sha256', digest: '0'.repeat(64), signature: { status: 'unsigned', algorithm: null, key_id: null, value: null } },
    permission_scope: 'project', trust: { level: 'shared-unverified', reasons: ['test'] },
    repository: { project_id: 'p', root_identity: id('a'), head: 'git-head', branch: 'main', merge_base: null, dirty: false, workspace_fingerprint: id('b') },
    phase: 'implementation', goal: { project: 'p', current_objective: objective, success_conditions: [] },
    plan: [], completed_work: [], decisions: [], evidence: [], assumptions: [], rejected_approaches: [], unknowns: [], blockers: [], risks: [], conflicts: [],
    working_stance: { confidence: 'medium', momentum: 'progressing', risk_posture: 'verify-before-change', attention: [], dissatisfaction: [], successor_behavior: [] },
    next_actions: [], references: [], extensions: {},
  } });
}

function observed(overrides = {}) {
  return { root_identity: id('a'), head: 'git-head', branch: 'main', dirty: false, workspace_fingerprint: id('b'), ancestors: ['git-head'], ...overrides };
}

function clientFor(states, headId, overrides = {}) {
  const fetched = [];
  return {
    fetched,
    async capabilities() { return { exact_bytes_durable: true, index_durable: true, relayer_index_id: id('c'), sync_protocol_version: SYNC_PROTOCOL_VERSION, reconciliation_policy_version: RECONCILIATION_POLICY_VERSION, ...overrides.capabilities }; },
    async getHeads() { return { heads: [headId], heads_digest: digestHeadSet([headId]), complete: true, ...overrides.heads }; },
    async getHistory() { return { history: [...states.values()].map((value) => ({ snapshot_id: value.snapshot_id, parent_snapshot_id: value.parent_snapshot_id })) }; },
    async getSnapshot(_project, snapshotId) { fetched.push(snapshotId); const value = states.get(snapshotId); return { bytes: Buffer.from(canonicalize(value)), etag: `"${snapshotId}"`, relayer_index_id: id('c') }; },
    async putSnapshot() { return { created: true }; },
  };
}

describe('ACP sync discovery', () => {
  it('fetches and validates every authority-bearing ancestor before reconciliation', async () => {
    const parent = envelope({ objective: 'parent' });
    const child = envelope({ parent: parent.snapshot_id, objective: 'child' });
    const states = new Map([[child.snapshot_id, child], [parent.snapshot_id, parent]]);
    const client = clientFor(states, child.snapshot_id);
    const result = await discoverRemoteState('/unused', 'p', {
      client, readState: async () => null, observeRepository: async () => observed(), clock: () => NOW,
    });
    assert.deepEqual(client.fetched.sort(), [child.snapshot_id, parent.snapshot_id].sort());
    assert.equal(result.reconciliation.action, 'remote-only-restore');
    assert.equal(result.validatedById.size, 2);
  });

  it('never issues confirmation for expired or over-bounded ancestry', async () => {
    const root = await temp();
    const expired = envelope({ expiresAt: '2026-07-12T12:00:00.000Z' });
    const expiredClient = clientFor(new Map([[expired.snapshot_id, expired]]), expired.snapshot_id);
    const expiredResult = await issueRemoteConfirmation(root, 'p', {
      client: expiredClient, readState: async () => null, observeRepository: async () => observed(), clock: () => NOW,
    });
    assert.equal(expiredResult.confirmation, null);
    assert.equal(expiredResult.reconciliation.reason, 'remote-expired');

    const history = Array.from({ length: ACP_LIMITS.ancestryEnvelopes + 1 }, (_, index) => ({ snapshot_id: `sha256:${index.toString(16).padStart(64, '0')}`, parent_snapshot_id: null }));
    const boundedClient = clientFor(new Map([[expired.snapshot_id, expired]]), expired.snapshot_id, { });
    boundedClient.getHistory = async () => ({ history });
    const bounded = await discoverRemoteState('/unused', 'p', { client: boundedClient, readState: async () => null, observeRepository: async () => observed(), clock: () => NOW });
    assert.equal(bounded.reconciliation.action, 'incomplete-lineage');
  });

  it('keeps advanced state historical by default and binds a newly issued override', async () => {
    const root = await temp();
    const remote = envelope();
    const client = clientFor(new Map([[remote.snapshot_id, remote]]), remote.snapshot_id);
    const advancedObserved = observed({ head: 'new-head', ancestors: ['new-head', 'git-head'] });
    const deps = { client, readState: async () => null, observeRepository: async () => advancedObserved, clock: () => NOW };
    const historical = await issueRemoteConfirmation(root, 'p', deps);
    assert.equal(historical.reconciliation.action, 'historical-advanced');
    assert.equal(historical.confirmation, null);
    const overridden = await issueRemoteConfirmation(root, 'p', deps, { allowStaleAdvanced: true });
    assert.equal(overridden.confirmation.allow_stale_advanced, true);
    assert.equal(overridden.confirmation.action, 'remote-only-restore');
  });
});

describe('ACP apply barrier', () => {
  function boundObservation(overrides = {}) {
    return {
      remote_snapshot_id: id('1'), local_snapshot_id: null, remote_heads_digest: id('2'), repository_observation_digest: REPOSITORY_DIGEST,
      relayer_index_id: id('4'), sync_protocol_version: SYNC_PROTOCOL_VERSION, reconciliation_policy_version: RECONCILIATION_POLICY_VERSION,
      action: 'remote-only-restore', allow_stale_advanced: false, canonical_remote: '{"remote":true}',
      remoteState: { envelope: { snapshot_id: id('1') } }, compatibility: { status: 'exact' }, ...overrides,
    };
  }

  async function confirmation(root) {
    return issueConfirmation(root, {
      remote_snapshot_id: id('1'), local_snapshot_id: null, remote_heads_digest: id('2'), repository_observation: observed(),
      relayer_index_id: id('4'), sync_protocol_version: SYNC_PROTOCOL_VERSION, reconciliation_policy_version: RECONCILIATION_POLICY_VERSION,
      action: 'remote-only-restore', allow_stale_advanced: false, remote_expires_at: null,
    }, NOW);
  }

  it('consumes once and rejects every independently changed confirmation binding without writing', async () => {
    const mutations = [
      ['remote_snapshot_id', id('9')], ['local_snapshot_id', id('9')], ['remote_heads_digest', id('9')],
      ['repository_observation_digest', id('9')], ['relayer_index_id', id('9')], ['sync_protocol_version', 'other'],
      ['reconciliation_policy_version', 'other'], ['action', 'fast-forward-local'], ['allow_stale_advanced', true],
    ];
    for (const [field, value] of mutations) {
      const root = await temp(); const issued = await confirmation(root); let writes = 0;
      const json = path.join(root, '.noosphere', 'continuity.json');
      const markdown = path.join(root, '.noosphere', 'continuity.md');
      await writeFile(json, 'prior-json'); await writeFile(markdown, 'prior-markdown');
      await assert.rejects(applyRemoteConfirmation(root, issued.confirmation_id, {
        clock: () => NOW, observeAndReconcile: async () => boundObservation({ [field]: value }),
        writeStateIfCurrent: async () => { writes += 1; },
      }), /confirmation-stale/);
      assert.equal(writes, 0);
      assert.equal(await readFile(json, 'utf8'), 'prior-json');
      assert.equal(await readFile(markdown, 'utf8'), 'prior-markdown');
      await assert.rejects(applyRemoteConfirmation(root, issued.confirmation_id, { clock: () => NOW }), /confirmation-missing/);
    }
  });

  it('rejects expiry and remote-byte mutation between both barrier observations', async () => {
    const expiredRoot = await temp(); const expired = await confirmation(expiredRoot);
    await assert.rejects(applyRemoteConfirmation(expiredRoot, expired.confirmation_id, { clock: () => NOW + 600_000 }), /confirmation-stale/);

    const root = await temp(); const issued = await confirmation(root); let calls = 0; let writes = 0;
    await assert.rejects(applyRemoteConfirmation(root, issued.confirmation_id, {
      clock: () => NOW,
      observeAndReconcile: async () => boundObservation({ canonical_remote: calls++ === 0 ? '{"remote":true}' : '{"remote":false}' }),
      writeStateIfCurrent: async () => { writes += 1; },
    }), /confirmation-stale/);
    assert.equal(writes, 0);
  });

  it('rejects changed remote bytes between issuance and apply', async () => {
    const root = await temp();
    const remote = envelope();
    const states = new Map([[remote.snapshot_id, remote]]);
    const client = clientFor(states, remote.snapshot_id);
    const deps = { client, readState: async () => null, observeRepository: async () => observed(), clock: () => NOW };
    const issued = await issueRemoteConfirmation(root, 'p', deps);
    states.get(remote.snapshot_id).goal.current_objective = 'tampered without re-addressing';
    let writes = 0;
    await assert.rejects(applyRemoteConfirmation(root, issued.confirmation.confirmation_id, {
      ...deps, projectId: 'p', writeStateIfCurrent: async () => { writes += 1; },
    }), /confirmation-stale/);
    assert.equal(writes, 0);
  });

  it('applies only after two identical complete observations', async () => {
    const root = await temp(); const issued = await confirmation(root); let writes = 0;
    const result = await applyRemoteConfirmation(root, issued.confirmation_id, {
      clock: () => NOW, observeAndReconcile: async () => boundObservation(),
      writeStateIfCurrent: async (_root, state, expected, options) => { writes += 1; return { state, expected, options }; },
    });
    assert.equal(writes, 1);
    assert.equal(result.expected, null);
  });

  it('passes the advanced trust projection into the local renderer without changing remote state', async () => {
    const root = await temp();
    const issued = await issueConfirmation(root, {
      remote_snapshot_id: id('1'), local_snapshot_id: null, remote_heads_digest: id('2'), repository_observation: observed(),
      relayer_index_id: id('4'), sync_protocol_version: SYNC_PROTOCOL_VERSION, reconciliation_policy_version: RECONCILIATION_POLICY_VERSION,
      action: 'remote-only-restore', allow_stale_advanced: true, remote_expires_at: null,
    }, NOW);
    const remoteState = { envelope: { snapshot_id: id('1'), plan: [], completed_work: [], decisions: [], evidence: [], assumptions: [], rejected_approaches: [], unknowns: [], blockers: [], risks: [], references: [], next_actions: [{ id: 'n1', repository_fingerprint: null }] } };
    let options;
    await applyRemoteConfirmation(root, issued.confirmation_id, {
      clock: () => NOW,
      observeAndReconcile: async () => boundObservation({ allow_stale_advanced: true, remoteState, compatibility: { status: 'advanced' } }),
      writeStateIfCurrent: async (_root, state, _expected, received) => { assert.equal(state, remoteState); options = received; },
    });
    assert.deepEqual(options.trustProjection.nonAuthoritativeNextActionIds, ['n1']);
    assert.equal(remoteState.envelope.snapshot_id, id('1'));
  });
});

describe('ACP sync listing interfaces', () => {
  it('lists bounded remote history through the exact client and safe quarantine files only', async () => {
    let capabilities = 0;
    const history = await listRemoteHistory('p', { head: id('1'), limit: 2 }, {
      client: { async capabilities() { capabilities += 1; }, async getHistory(_project, options) { return { history: [options] }; } },
    });
    assert.equal(capabilities, 1);
    assert.equal(history.history[0].limit, 2);

    const root = await temp(); const directory = path.join(root, '.noosphere', 'quarantine');
    await mkdir(directory, { recursive: true });
    const safe = `sha256-${'a'.repeat(64)}.json`;
    await writeFile(path.join(directory, safe), 'bytes');
    await writeFile(path.join(directory, 'unsafe.json'), 'ignored');
    await symlink(path.join(directory, safe), path.join(directory, `sha256-${'b'.repeat(64)}.json`));
    assert.deepEqual((await listQuarantine(root)).map(({ name }) => name), [safe]);
  });
});
