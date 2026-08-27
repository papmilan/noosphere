import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ACP_PROTOCOL, ACP_SCHEMA_VERSION } from '../continuity/acp/project-state.js';
import { decodeEnvelope, digestEnvelope } from '../continuity/acp/wire.js';
import { applyUpdate } from '../continuity/acp/merge.js';

const CREATED_AT = '2026-07-12T00:00:00.000Z';

function envelope(overrides = {}) {
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
      root_identity: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      head: null, branch: null, merge_base: null, dirty: false,
      workspace_fingerprint: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
    phase: 'implementation',
    goal: {
      project: 'Continuity.', current_objective: 'Merge safely.',
      success_conditions: ['No silent loss.'],
    },
    plan: [], completed_work: [], decisions: [], evidence: [], assumptions: [],
    rejected_approaches: [], unknowns: [], blockers: [], risks: [], conflicts: [],
    working_stance: {
      confidence: 'medium', momentum: 'progressing', risk_posture: 'verify-before-change',
      attention: [], dissatisfaction: [], successor_behavior: [],
    },
    next_actions: [],
    references: [{ id: 'r1', kind: 'file', locator: 'README.md' }],
    extensions: {},
    ...overrides,
  };
  const digest = digestEnvelope(base);
  base.integrity.digest = digest;
  base.snapshot_id = `sha256:${digest}`;
  return base;
}

function decision(id, text, overrides = {}) {
  return {
    id, text, domain: 'storage', status: 'active', confidence: 'high',
    provenance: ['r1'], created_at: CREATED_AT, expires_at: null,
    repository_fingerprint: null, supersedes: [], ...overrides,
  };
}

function nextAction(id, text, overrides = {}) {
  return {
    id, text, status: 'planned', confidence: 'medium', provenance: ['r1'],
    created_at: CREATED_AT, expires_at: null, repository_fingerprint: null,
    supersedes: [], priority: 1, ...overrides,
  };
}

function state(overrides) {
  const result = decodeEnvelope(envelope(overrides), { clock: CREATED_AT });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return result.state;
}

const inputs = { clock: CREATED_AT };

describe('applyUpdate', () => {
  it('does not choose between stale competing decisions', () => {
    const current = state({ decisions: [decision('d1', 'SQLite')] });
    const update = state({ decisions: [decision('d2', 'Postgres')], parent_snapshot_id: null });
    const result = applyUpdate(current, update, inputs);
    assert.equal(result.ok, true);
    assert.equal(result.conflicts[0].kind, 'decision-domain');
  });

  it('fast-forwards an update that descends from the current snapshot', () => {
    const current = state({ decisions: [decision('d1', 'SQLite')] });
    const update = state({
      decisions: [decision('d1', 'SQLite'), decision('d2', 'Redis', { domain: 'cache' })],
      parent_snapshot_id: current.envelope.snapshot_id,
    });
    const result = applyUpdate(current, update, inputs);
    assert.equal(result.ok, true);
    assert.equal(result.state.runtime.activeByType.decisions.length, 2);
    assert.equal(result.conflicts.length, 0);
  });

  it('rejects a fast-forward that switches repository identity', () => {
    const current = state({ decisions: [decision('d1', 'SQLite')] });
    const update = state({
      decisions: [decision('d9', 'Foreign state')],
      parent_snapshot_id: current.envelope.snapshot_id,
      repository: {
        ...current.envelope.repository,
        project_id: 'foreign-project',
        root_identity: `sha256:${'f'.repeat(64)}`,
      },
    });
    const result = applyUpdate(current, update, inputs);
    assert.equal(result.ok, false);
    assert.equal(result.errors.some(({ code }) => code === 'foreign-project'), true);
  });

  it('appends distinct new assertions from a stale update', () => {
    const current = state({ assumptions: [{ id: 'a1', text: 'X', status: 'active', confidence: 'low', provenance: ['r1'], created_at: CREATED_AT, expires_at: null, repository_fingerprint: null, supersedes: [] }] });
    const update = state({ assumptions: [{ id: 'a2', text: 'Y', status: 'active', confidence: 'low', provenance: ['r1'], created_at: CREATED_AT, expires_at: null, repository_fingerprint: null, supersedes: [] }] });
    const result = applyUpdate(current, update, inputs);
    assert.equal(result.ok, true);
    assert.deepEqual(result.state.runtime.activeByType.assumptions, ['a1', 'a2']);
  });

  it('creates a digest-valid direct descendant when synthesizing a stale merge', () => {
    const current = state({ assumptions: [{ id: 'a1', text: 'X', status: 'active', confidence: 'low', provenance: ['r1'], created_at: CREATED_AT, expires_at: null, repository_fingerprint: null, supersedes: [] }] });
    const update = state({ assumptions: [{ id: 'a2', text: 'Y', status: 'active', confidence: 'low', provenance: ['r1'], created_at: CREATED_AT, expires_at: null, repository_fingerprint: null, supersedes: [] }] });
    const result = applyUpdate(current, update, inputs);
    assert.equal(result.ok, true);
    const { envelope: merged } = result.state;
    assert.equal(merged.parent_snapshot_id, current.envelope.snapshot_id);
    assert.equal(merged.integrity.digest, digestEnvelope(merged));
    assert.equal(merged.snapshot_id, `sha256:${merged.integrity.digest}`);
  });

  it('does not launder unverified stale input through a verified current envelope', () => {
    const current = state({
      assumptions: [{ id: 'a1', text: 'X', status: 'active', confidence: 'low', provenance: ['r1'], created_at: CREATED_AT, expires_at: null, repository_fingerprint: null, supersedes: [] }],
      trust: { level: 'shared-verified', reasons: ['signed upstream'] },
      integrity: {
        algorithm: 'sha256',
        digest: '0'.repeat(64),
        signature: { status: 'signed', algorithm: 'ed25519', key_id: 'key-1', value: 'signature' },
      },
    });
    const update = state({ assumptions: [{ id: 'a2', text: 'Y', status: 'active', confidence: 'low', provenance: ['r1'], created_at: CREATED_AT, expires_at: null, repository_fingerprint: null, supersedes: [] }] });
    const result = applyUpdate(current, update, inputs);
    assert.equal(result.ok, true);
    assert.equal(result.state.envelope.trust.level, 'local-unverified');
    assert.equal(result.state.envelope.integrity.signature.status, 'unsigned');
  });

  it('contests a changed reference and rejects assertions that rely on it', () => {
    const current = state({ references: [{ id: 'r1', kind: 'file', locator: 'README.md' }] });
    const update = state({
      references: [{ id: 'r1', kind: 'external', locator: 'https://example.invalid/untrusted' }],
      assumptions: [{ id: 'a2', text: 'Based on changed reference', status: 'active', confidence: 'low', provenance: ['r1'], created_at: CREATED_AT, expires_at: null, repository_fingerprint: null, supersedes: [] }],
    });
    const result = applyUpdate(current, update, inputs);
    assert.equal(result.ok, true);
    assert.equal(result.conflicts.some((conflict) => conflict.kind === 'reference-modified'), true);
    assert.equal(result.state.runtime.byId.a2, undefined);
    assert.equal(result.state.runtime.referencesById.r1.locator, 'README.md');
  });

  it('creates a conflict when a stale update changes an existing assertion', () => {
    const current = state({ decisions: [decision('d1', 'SQLite')] });
    const update = state({ decisions: [decision('d1', 'Postgres')] });
    const result = applyUpdate(current, update, inputs);
    assert.equal(result.ok, true);
    assert.equal(result.conflicts.some((c) => c.kind === 'assertion-modified'), true);
    assert.equal(result.state.runtime.byId.d1.text, 'SQLite');
  });

  it('contests a stale supersession instead of applying it', () => {
    const current = state({ decisions: [decision('d1', 'SQLite')] });
    const update = state({ decisions: [decision('d9', 'Postgres', { supersedes: ['d1'] })] });
    const result = applyUpdate(current, update, inputs);
    assert.equal(result.conflicts.some((c) => c.kind === 'supersession-contested'), true);
  });

  it('flags competing priority-1 next actions', () => {
    const current = state({ next_actions: [nextAction('n1', 'Ship A')] });
    const update = state({ next_actions: [nextAction('n2', 'Ship B')] });
    const result = applyUpdate(current, update, inputs);
    assert.equal(result.conflicts.filter((conflict) => conflict.kind === 'priority-contention').length, 1);
  });

  it('is deterministic for repeated identical merges', () => {
    const current = state({ decisions: [decision('d1', 'SQLite')] });
    const update = state({ decisions: [decision('d1', 'Postgres')] });
    const a = applyUpdate(current, update, inputs);
    const b = applyUpdate(current, update, inputs);
    assert.deepEqual(a.conflicts, b.conflicts);
    assert.deepEqual(a.state.envelope, b.state.envelope);
  });
});
