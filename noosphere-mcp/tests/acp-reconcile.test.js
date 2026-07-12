import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { reconcileExactState } from '../continuity/acp/reconcile.js';
import { projectAdvancedTrust } from '../continuity/acp/trust-projection.js';

const id = (char) => `sha256:${char.repeat(64)}`;
const LOCAL = id('a'); const PARENT = id('b'); const REMOTE = id('c'); const OTHER = id('d');
const CLOCK = Date.parse('2026-07-13T00:00:00.000Z');
const DEFAULT_POLICY = Object.freeze({ allowStaleAdvanced: false });

function state(snapshotId, parent = null, overrides = {}) {
  return {
    envelope: {
      snapshot_id: snapshotId, parent_snapshot_id: parent,
      created_at: '2026-07-12T00:00:00.000Z', expires_at: null,
      repository: { project_id: 'p', root_identity: id('f') },
      plan: [], completed_work: [], decisions: [], evidence: [], assumptions: [],
      rejected_approaches: [], unknowns: [], blockers: [], risks: [], next_actions: [], references: [],
      ...overrides,
    },
  };
}

function reconcile({ local = state(LOCAL, PARENT), heads = [REMOTE], states, compatibility = { status: 'exact', trustDowngrade: 0 }, policy = DEFAULT_POLICY, historyById, projectId, rootIdentity } = {}) {
  const values = states
    ? [...states.filter((value) => value.envelope.snapshot_id !== local?.envelope?.snapshot_id), ...(local ? [local] : [])]
    : [state(PARENT), ...(local ? [local] : []), state(REMOTE, LOCAL)];
  return reconcileExactState({
    local, remoteHeads: heads, validatedById: new Map(values.map((value) => [value.envelope.snapshot_id, value])),
    compatibility, clock: CLOCK, policy, historyById, projectId, rootIdentity,
  });
}

describe('reconcileExactState', () => {
  it('covers identical, remote descendant, local descendant, and divergent lineage', () => {
    assert.equal(reconcile({ heads: [LOCAL] }).action, 'already-synced');
    assert.deepEqual(reconcile(), { action: 'fast-forward-local', candidate_snapshot_id: REMOTE, actionable: true, requires_confirmation: true, trust_downgrade: 0 });
    assert.equal(reconcile({ heads: [PARENT] }).action, 'push-local');
    assert.equal(reconcile({ states: [state(PARENT), state(LOCAL, PARENT), state(REMOTE, OTHER), state(OTHER)] }).action, 'diverged');
    assert.equal(reconcile({ heads: [] }).action, 'push-local');
  });

  it('never arbitrarily chooses among concurrent remote heads', () => {
    const result = reconcile({ heads: [OTHER, REMOTE], states: [state(PARENT), state(LOCAL, PARENT), state(REMOTE, LOCAL), state(OTHER, LOCAL)] });
    assert.deepEqual(result, { action: 'diverged', actionable: false, remote_heads: [REMOTE, OTHER].sort() });
  });

  it('returns incomplete lineage for missing ancestry, metadata disagreement, or over 200 validated states', () => {
    assert.equal(reconcile({ states: [state(LOCAL, PARENT), state(REMOTE, OTHER)] }).action, 'incomplete-lineage');
    assert.equal(reconcile({ historyById: new Map([[REMOTE, { parent_snapshot_id: OTHER }]]) }).action, 'incomplete-lineage');
    const many = Array.from({ length: 201 }, (_, index) => state(`sha256:${index.toString(16).padStart(64, '0')}`));
    assert.equal(reconcile({ states: many }).action, 'incomplete-lineage');
  });

  it('quarantines foreign identity and expired remote candidates', () => {
    assert.deepEqual(reconcile({ states: [state(LOCAL, PARENT), state(REMOTE, LOCAL, { repository: { project_id: 'other', root_identity: id('f') } })] }), {
      action: 'quarantine', reason: 'foreign-state', actionable: false, remote_heads: [REMOTE],
    });
    assert.deepEqual(reconcile({ states: [state(LOCAL, PARENT), state(REMOTE, LOCAL, { expires_at: '2020-01-01T00:00:00.000Z' })] }), {
      action: 'quarantine', reason: 'remote-expired', actionable: false, remote_heads: [REMOTE],
    });
    assert.equal(reconcile({
      local: state(LOCAL),
      states: [state(LOCAL), state(PARENT, LOCAL, { repository: { project_id: 'other', root_identity: id('f') } }), state(REMOTE, PARENT)],
    }).reason, 'foreign-state');
  });

  it('handles every Git compatibility status and advanced override policy', () => {
    for (const status of ['exact', 'compatible']) assert.equal(reconcile({ compatibility: { status, trustDowngrade: status === 'exact' ? 0 : 1 } }).action, 'fast-forward-local');
    assert.deepEqual(reconcile({ compatibility: { status: 'advanced', trustDowngrade: 1 } }), {
      action: 'historical-advanced', candidate_snapshot_id: REMOTE, actionable: false, trust_downgrade: 1,
    });
    assert.deepEqual(reconcile({ compatibility: { status: 'advanced', trustDowngrade: 1 }, policy: { allowStaleAdvanced: true } }), {
      action: 'fast-forward-local', candidate_snapshot_id: REMOTE, actionable: true, requires_confirmation: true, trust_downgrade: 1,
    });
    for (const status of ['diverged', 'foreign', 'unknown']) assert.equal(reconcile({ compatibility: { status, trustDowngrade: 3 } }).action, status === 'foreign' ? 'quarantine' : 'deferred');
  });

  it('restores one complete actionable remote when local state is absent', () => {
    const remote = state(REMOTE);
    assert.equal(reconcile({ local: null, states: [remote], heads: [REMOTE] }).action, 'remote-only-restore');
    assert.equal(reconcile({ local: null, states: [remote], heads: [REMOTE], rootIdentity: id('e') }).reason, 'foreign-state');
  });

  it('is stable across map and head response order', () => {
    const states = [state(PARENT), state(LOCAL, PARENT), state(REMOTE, LOCAL), state(OTHER, LOCAL)];
    assert.deepEqual(reconcile({ heads: [OTHER, REMOTE], states }), reconcile({ heads: [REMOTE, OTHER], states: [...states].reverse() }));
  });

  it('rejects mis-keyed authority entries and unvalidated local references deterministically', () => {
    const local = state(LOCAL, PARENT);
    const remote = state(REMOTE, LOCAL);
    const invalid = { action: 'quarantine', reason: 'invalid-authority-graph', actionable: false, remote_heads: [REMOTE] };
    const input = { remoteHeads: [REMOTE], compatibility: { status: 'exact' }, clock: CLOCK, policy: DEFAULT_POLICY };
    assert.deepEqual(reconcileExactState({ ...input, local, validatedById: new Map([[OTHER, remote], [LOCAL, local]]) }), invalid);
    assert.deepEqual(reconcileExactState({ ...input, local: structuredClone(local), validatedById: new Map([[REMOTE, remote], [LOCAL, local], [PARENT, state(PARENT)]]) }), invalid);
    assert.deepEqual(reconcileExactState({ ...input, local, validatedById: new Map([[REMOTE, remote], [PARENT, state(PARENT)]]) }), invalid);
  });
});

describe('projectAdvancedTrust', () => {
  it('projects repository-dependent authority without mutating canonical state', () => {
    const bound = { id: 'bound', repository_fingerprint: id('1') };
    const unbound = { id: 'unbound', repository_fingerprint: null };
    const input = state(REMOTE, LOCAL, {
      plan: [bound, unbound], next_actions: [{ id: 'next-z', repository_fingerprint: null }, { id: 'next-a', repository_fingerprint: null }],
      references: ['file', 'commit', 'command', 'test', 'journal', 'external'].map((kind) => ({ id: `ref-${kind}`, kind })),
    });
    const before = structuredClone(input);
    assert.deepEqual(projectAdvancedTrust(input), {
      trustDowngrade: 1,
      nonAuthoritativeAssertionIds: ['bound'],
      nonAuthoritativeReferenceIds: ['ref-command', 'ref-commit', 'ref-file', 'ref-test'],
      nonAuthoritativeNextActionIds: ['next-a', 'next-z'],
    });
    assert.deepEqual(input, before);
    assert.equal(input.envelope.snapshot_id, REMOTE);
  });
});
