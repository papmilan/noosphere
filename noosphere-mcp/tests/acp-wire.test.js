import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ACP_PROTOCOL,
  ACP_SCHEMA_VERSION,
} from '../continuity/acp/project-state.js';
import {
  canonicalize,
  decodeEnvelope,
  digestEnvelope,
  encodeEnvelope,
} from '../continuity/acp/wire.js';

const CREATED_AT = '2026-07-12T00:00:00.000Z';

function baseEnvelope(overrides = {}) {
  return {
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

// A valid envelope carries a digest and snapshot_id derived from its own content.
function signedEnvelope(overrides = {}) {
  const envelope = baseEnvelope(overrides);
  const digest = digestEnvelope(envelope);
  envelope.integrity.digest = digest;
  envelope.snapshot_id = `sha256:${digest}`;
  return envelope;
}

describe('canonicalize', () => {
  it('sorts object keys but preserves declared array order', () => {
    assert.equal(canonicalize({ z: 1, a: ['second', 'first'] }), '{"a":["second","first"],"z":1}');
  });

  it('is independent of key insertion order', () => {
    assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
  });

  it('normalizes CRLF and CR line endings to LF', () => {
    assert.equal(canonicalize({ a: 'x\r\ny\rz' }), '{"a":"x\\ny\\nz"}');
  });

  it('normalizes Unicode to NFC before serializing', () => {
    assert.equal(canonicalize({ a: 'Café' }), canonicalize({ a: 'Café' }));
  });

  it('rejects non-finite numbers', () => {
    assert.throws(() => canonicalize({ a: Infinity }));
    assert.throws(() => canonicalize({ a: NaN }));
  });
});

describe('digestEnvelope', () => {
  it('excludes snapshot_id, integrity.digest and signature.value from the digest', () => {
    const a = baseEnvelope();
    const b = baseEnvelope();
    b.snapshot_id = 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    b.integrity.digest = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    b.integrity.signature.value = 'deadbeef';
    assert.equal(digestEnvelope(a), digestEnvelope(b));
  });
});

describe('decodeEnvelope', () => {
  it('decodes a correctly signed envelope into project state', () => {
    const result = decodeEnvelope(signedEnvelope(), { clock: CREATED_AT });
    assert.equal(result.ok, true);
    assert.equal(result.state.envelope.goal.project, 'Create reliable cross-agent project continuity.');
  });

  it('accepts a serialized JSON string', () => {
    const result = decodeEnvelope(JSON.stringify(signedEnvelope()), { clock: CREATED_AT });
    assert.equal(result.ok, true);
  });

  it('rejects a mismatched digest', () => {
    const input = signedEnvelope();
    input.snapshot_id = 'sha256:wrong';
    input.integrity.digest = 'wrong';
    assert.equal(decodeEnvelope(input, { clock: CREATED_AT }).errors[0].code, 'digest-mismatch');
  });

  it('rejects a snapshot_id that does not match the digest', () => {
    const input = signedEnvelope();
    input.snapshot_id = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
    const result = decodeEnvelope(input, { clock: CREATED_AT });
    assert.equal(result.ok, false);
    assert.equal(result.errors.some(({ code }) => code === 'snapshot-mismatch'), true);
  });

  it('rejects malformed JSON', () => {
    const result = decodeEnvelope('{not json', { clock: CREATED_AT });
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'malformed-json');
  });

  it('ignores signature value when verifying integrity', () => {
    const input = signedEnvelope({
      integrity: {
        algorithm: 'sha256',
        digest: '0'.repeat(64),
        signature: { status: 'signed', algorithm: 'ed25519', key_id: 'key-1', value: 'initial-signature' },
      },
    });
    input.integrity.signature.value = 'a-later-signature';
    assert.equal(decodeEnvelope(input, { clock: CREATED_AT }).ok, true);
  });
});

describe('encodeEnvelope', () => {
  it('recomputes digest and snapshot_id so the result decodes cleanly', () => {
    const state = decodeEnvelope(signedEnvelope(), { clock: CREATED_AT }).state;
    const encoded = encodeEnvelope(state);
    assert.match(encoded.snapshot_id, /^sha256:[a-f0-9]{64}$/);
    assert.equal(encoded.integrity.digest, encoded.snapshot_id.slice('sha256:'.length));
    assert.equal(decodeEnvelope(encoded, { clock: CREATED_AT }).ok, true);
  });
});
