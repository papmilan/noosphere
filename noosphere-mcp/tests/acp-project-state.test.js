import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  ACP_PROTOCOL,
  ACP_SCHEMA_VERSION,
  createProjectState,
} from '../continuity/acp/project-state.js';

const CREATED_AT = '2026-07-12T00:00:00.000Z';

function validEnvelope(overrides = {}) {
  return {
    protocol: ACP_PROTOCOL,
    schema_version: ACP_SCHEMA_VERSION,
    snapshot_id: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    parent_snapshot_id: null,
    created_at: CREATED_AT,
    expires_at: null,
    origin: { agent_id: 'codex', client: 'codex-desktop', session_id: null },
    integrity: {
      algorithm: 'sha256',
      digest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      signature: { status: 'unsigned', algorithm: null, key_id: null, value: null },
    },
    permission_scope: 'project',
    trust: { level: 'local-unverified', reasons: ['unsigned local envelope'] },
    repository: {
      project_id: 'noosphere',
      root_identity: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      head: null,
      branch: null,
      merge_base: null,
      dirty: false,
      workspace_fingerprint: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
    phase: 'implementation',
    goal: {
      project: 'Create reliable cross-agent project continuity.',
      current_objective: 'Implement the ACP continuity kernel.',
      success_conditions: ['A fresh agent selects the correct next action.'],
    },
    plan: [],
    completed_work: [],
    decisions: [],
    evidence: [],
    assumptions: [],
    rejected_approaches: [],
    unknowns: [],
    blockers: [],
    risks: [],
    conflicts: [],
    working_stance: {
      confidence: 'medium',
      momentum: 'progressing',
      risk_posture: 'verify-before-change',
      attention: [],
      dissatisfaction: [],
      successor_behavior: [],
    },
    next_actions: [],
    references: [],
    extensions: {},
    ...overrides,
  };
}

function decision(id, text, overrides = {}) {
  return {
    id,
    text,
    domain: 'storage',
    status: 'active',
    confidence: 'high',
    provenance: ['r1'],
    created_at: CREATED_AT,
    expires_at: null,
    repository_fingerprint: null,
    supersedes: [],
    ...overrides,
  };
}

function decisionConflict(overrides = {}) {
  return {
    kind: 'decision-domain',
    severity: 'high',
    status: 'unresolved',
    domain: 'storage',
    candidates: [{
      assertion_id: 'd1',
      value: 'SQLite',
      provenance: ['r1'],
      repository_binding: null,
      trust: 'local-unverified',
      created_at: CREATED_AT,
      expires_at: null,
    }],
    ...overrides,
  };
}

describe('createProjectState', () => {
  it('rejects duplicate assertion IDs', () => {
    const input = validEnvelope({
      references: [{ id: 'r1', kind: 'file', locator: 'README.md' }],
      decisions: [decision('d1', 'SQLite'), decision('d1', 'Postgres')],
    });

    const result = createProjectState(input, { clock: input.created_at });

    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'duplicate-id');
  });

  it('rejects canonically equivalent IDs before building runtime state', () => {
    const input = validEnvelope({
      references: [{ id: 'r1', kind: 'file', locator: 'README.md' }],
      decisions: [
        decision('Cafe\u0301\r\nchoice', 'SQLite'),
        decision('Café\nchoice', 'Postgres'),
      ],
    });

    const result = createProjectState(input, { clock: input.created_at });

    assert.equal(result.ok, false);
    assert.equal(result.errors.some(({ code }) => code === 'duplicate-id'), true);
    assert.equal('state' in result, false);
  });

  it('creates an unresolved conflict for active decisions in one domain', () => {
    const input = validEnvelope({
      references: [{ id: 'r1', kind: 'file', locator: 'README.md' }],
      decisions: [decision('d1', 'SQLite'), decision('d2', 'Postgres')],
    });

    const result = createProjectState(input, { clock: input.created_at });

    assert.equal(result.ok, true);
    assert.deepEqual(result.state.runtime.conflicts, [{
      kind: 'decision-domain',
      severity: 'high',
      status: 'unresolved',
      domain: 'storage',
      candidates: [
        {
          assertion_id: 'd1', value: 'SQLite', provenance: ['r1'], repository_binding: null,
          trust: 'local-unverified', created_at: CREATED_AT, expires_at: null,
        },
        {
          assertion_id: 'd2', value: 'Postgres', provenance: ['r1'], repository_binding: null,
          trust: 'local-unverified', created_at: CREATED_AT, expires_at: null,
        },
      ],
    }]);
  });

  it('excludes expired assertions from active indexes using the supplied clock', () => {
    const input = validEnvelope({
      references: [{ id: 'r1', kind: 'file', locator: 'README.md' }],
      decisions: [decision('d1', 'Expired choice', {
        expires_at: '2026-07-12T00:00:01.000Z',
      })],
    });

    const result = createProjectState(input, {
      clock: '2026-07-12T00:00:02.000Z',
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.state.runtime.activeByType.decisions, []);
  });

  it('deep-freezes the normalized envelope and runtime indexes', () => {
    const input = validEnvelope();
    const result = createProjectState(input, { clock: input.created_at });

    assert.equal(result.ok, true);
    assert.equal(Object.isFrozen(result.state), true);
    assert.equal(Object.isFrozen(result.state.envelope.goal), true);
    assert.equal(Object.isFrozen(result.state.runtime.byId), true);
    assert.throws(() => {
      result.state.envelope.goal.project = 'Changed';
    }, TypeError);
  });

  it('orders decision-domain conflicts by domain and assertion ID', () => {
    const input = validEnvelope({
      references: [{ id: 'r1', kind: 'file', locator: 'README.md' }],
      decisions: [
        decision('z2', 'Postgres', { domain: 'storage' }),
        decision('z1', 'SQLite', { domain: 'storage' }),
        decision('a2', 'Redis', { domain: 'cache' }),
        decision('a1', 'Memcached', { domain: 'cache' }),
      ],
    });

    const result = createProjectState(input, { clock: input.created_at });

    assert.equal(result.ok, true);
    assert.deepEqual(result.state.runtime.conflicts, [
      {
        kind: 'decision-domain',
        severity: 'high',
        status: 'unresolved',
        domain: 'cache',
        candidates: [
          { assertion_id: 'a1', value: 'Memcached', provenance: ['r1'], repository_binding: null, trust: 'local-unverified', created_at: CREATED_AT, expires_at: null },
          { assertion_id: 'a2', value: 'Redis', provenance: ['r1'], repository_binding: null, trust: 'local-unverified', created_at: CREATED_AT, expires_at: null },
        ],
      },
      {
        kind: 'decision-domain',
        severity: 'high',
        status: 'unresolved',
        domain: 'storage',
        candidates: [
          { assertion_id: 'z1', value: 'SQLite', provenance: ['r1'], repository_binding: null, trust: 'local-unverified', created_at: CREATED_AT, expires_at: null },
          { assertion_id: 'z2', value: 'Postgres', provenance: ['r1'], repository_binding: null, trust: 'local-unverified', created_at: CREATED_AT, expires_at: null },
        ],
      },
    ]);
  });

  it('accepts omitted optional parent and expiry fields', () => {
    const input = validEnvelope();
    delete input.parent_snapshot_id;
    delete input.expires_at;

    const result = createProjectState(input, { clock: input.created_at });

    assert.equal(result.ok, true);
  });

  it('accepts omitted assertion expiry fields', () => {
    const item = decision('d1', 'SQLite');
    delete item.expires_at;
    const input = validEnvelope({
      references: [{ id: 'r1', kind: 'file', locator: 'README.md' }],
      decisions: [item],
    });

    const result = createProjectState(input, { clock: input.created_at });

    assert.equal(result.ok, true);
  });

  it('indexes prototype-sensitive IDs and domains without mutation or crashes', () => {
    const input = validEnvelope({
      references: [{ id: 'r1', kind: 'file', locator: 'README.md' }],
      decisions: [
        decision('__proto__', 'SQLite', { domain: '__proto__' }),
        decision('toString', 'Postgres', { domain: '__proto__' }),
      ],
    });

    const result = createProjectState(input, { clock: input.created_at });

    assert.equal(result.ok, true);
    assert.equal(Object.getPrototypeOf(result.state.runtime.byId), null);
    assert.equal(Object.getPrototypeOf(result.state.runtime.activeDecisionsByDomain), null);
    assert.deepEqual(result.state.runtime.activeDecisionsByDomain.__proto__, ['__proto__', 'toString']);
  });

  it('accepts persisted v1 conflicts with candidate values and context', () => {
    const input = validEnvelope({
      references: [{ id: 'r1', kind: 'file', locator: 'README.md' }],
      conflicts: [decisionConflict()],
    });

    const result = createProjectState(input, { clock: input.created_at });

    assert.equal(result.ok, true);
  });

  it('bounds nested extension values recursively', () => {
    const oversizedText = validEnvelope({ extensions: { 'example.com.payload': { nested: ['x'.repeat(4_001)] } } });
    const oversizedArray = validEnvelope({ extensions: { 'example.com.payload': { nested: Array.from({ length: 101 }, () => 'ok') } } });

    assert.equal(createProjectState(oversizedText, { clock: CREATED_AT }).ok, false);
    assert.equal(createProjectState(oversizedArray, { clock: CREATED_AT }).ok, false);
  });

  it('rejects a 20,000-level extension without throwing', () => {
    let nested = 'leaf';
    for (let index = 0; index < 20_000; index += 1) nested = { nested };
    const input = validEnvelope({ extensions: { 'example.com.payload': nested } });

    const result = createProjectState(input, { clock: CREATED_AT });

    assert.equal(result.ok, false);
    assert.equal(result.errors.some(({ code }) => code === 'extension-too-deep'), true);
  });

  it('normalizes runtime string values from CRLF or CR to LF before NFC', () => {
    const input = validEnvelope({
      goal: {
        project: 'Cafe\r\nCafe\u0301\rLine',
        current_objective: 'Normalize values.',
        success_conditions: ['Keep line endings stable.'],
      },
    });

    const result = createProjectState(input, { clock: input.created_at });

    assert.equal(result.ok, true);
    assert.equal(result.state.envelope.goal.project, 'Cafe\nCafé\nLine');
  });

  it('publishes the lifecycle statuses accepted by the runtime', () => {
    const schema = JSON.parse(readFileSync(new URL('../continuity/acp/schema.json', import.meta.url), 'utf8'));

    assert.deepEqual(schema.$defs.assertion.properties.status.enum, ['active', 'resolved', 'superseded', 'rejected']);
    assert.deepEqual(schema.$defs.planAssertion.properties.status.enum, ['planned', 'in_progress', 'completed', 'blocked', 'superseded']);
    assert.deepEqual(schema.$defs.conflict.properties.status.enum, ['unresolved', 'resolved']);
  });

  it('uses finite schema levels that match runtime extension bounds', () => {
    const schema = JSON.parse(readFileSync(new URL('../continuity/acp/schema.json', import.meta.url), 'utf8'));
    const extension = schema.$defs.extensions;

    assert.equal(extension.additionalProperties.$ref, '#/$defs/extensionValue1');
    for (let depth = 1; depth < 10; depth += 1) {
      const level = schema.$defs[`extensionValue${depth}`];
      assert.equal(level.anyOf[1].maxItems, 100);
      assert.equal(level.anyOf[1].items.$ref, `#/$defs/extensionValue${depth + 1}`);
      assert.equal(level.anyOf[2].maxProperties, 20);
      assert.equal(level.anyOf[2].additionalProperties.$ref, `#/$defs/extensionValue${depth + 1}`);
    }
    assert.equal(schema.$defs.extensionValue10.$ref, '#/$defs/extensionScalar');
    assert.equal(schema.$defs.extensionScalar.anyOf.length, 4);
    assert.equal(schema.$defs.extensionText.maxLength, 4000);

    const oversized = validEnvelope({ extensions: { 'example.com.payload': 'x'.repeat(4_001) } });
    const overDepth = validEnvelope({ extensions: { 'example.com.payload': { nested: { nested: { nested: { nested: { nested: { nested: { nested: { nested: { nested: { nested: 'leaf' } } } } } } } } } } } });
    assert.equal(createProjectState(oversized, { clock: CREATED_AT }).ok, false);
    assert.equal(createProjectState(overDepth, { clock: CREATED_AT }).ok, false);
  });
});
