import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodeEnvelope } from '@noosphere/acp-protocol';
import { decodeProjectStateEnvelope } from '../acp-protocol.js';

const required = {
  protocol: 'acp.project-state-envelope', schema_version: '1.0.0', snapshot_id: '',
  parent_snapshot_id: null, created_at: '2026-07-12T00:00:00.000Z', expires_at: null,
  origin: { agent_id: 'agent', client: 'test', session_id: null },
  integrity: { algorithm: 'sha256', digest: '', signature: { status: 'unsigned', algorithm: null, key_id: null, value: null } },
  permission_scope: 'project', trust: { level: 'local-unverified', reasons: ['unsigned test fixture'] },
  repository: { project_id: 'p', root_identity: `sha256:${'a'.repeat(64)}`, head: null, branch: null, merge_base: null, dirty: false, workspace_fingerprint: `sha256:${'b'.repeat(64)}` },
  phase: 'implementation', goal: { project: 'p', current_objective: 'test', success_conditions: [] }, plan: [],
  completed_work: [], decisions: [], evidence: [], assumptions: [], rejected_approaches: [], unknowns: [],
  blockers: [], risks: [], conflicts: [], working_stance: { confidence: 'medium', momentum: 'progressing', risk_posture: 'verify-before-change', attention: [], dissatisfaction: [], successor_behavior: [] }, next_actions: [], references: [], extensions: {},
};
const encoded = () => encodeEnvelope({ envelope: structuredClone(required) });

describe('relayer ACP protocol boundary', () => {
  it('preserves shared decoder errors for malformed and non-object input', () => {
    assert.equal(decodeProjectStateEnvelope('{not json').errors[0].code, 'malformed-json');
    assert.equal(decodeProjectStateEnvelope([]).errors[0].code, 'invalid-type');
  });

  it('uses shared wire decoding and accepts required protocol fields', () => {
    const decoded = decodeProjectStateEnvelope(JSON.stringify(encoded()));
    assert.equal(decoded.ok, true, JSON.stringify(decoded.errors));
  });

  it('rejects missing required fields and unsupported versions', () => {
    const missing = encoded(); delete missing.goal;
    const resignedMissing = encodeEnvelope({ envelope: missing });
    assert.equal(decodeProjectStateEnvelope(resignedMissing).errors.some(({ code }) => code === 'required'), true);
    const version = encoded(); version.schema_version = '2.0.0';
    const resigned = encodeEnvelope({ envelope: version });
    assert.equal(decodeProjectStateEnvelope(resigned).errors[0].code, 'unsupported-version');
  });

  it('rejects nested extra, forbidden, malformed domain, and self-parent fields', () => {
    const mutations = [
      (value) => { value.goal.extra = true; },
      (value) => { value.extensions['org.example'] = { api_key: 'secret' }; },
      (value) => { value.repository.dirty = 'yes'; },
    ];
    for (const mutate of mutations) {
      const value = encoded();
      mutate(value);
      const resigned = encodeEnvelope({ envelope: value });
      assert.equal(decodeProjectStateEnvelope(resigned).ok, false);
    }
    const selfParent = encoded();
    selfParent.parent_snapshot_id = selfParent.snapshot_id;
    assert.equal(decodeProjectStateEnvelope(selfParent).ok, false);
  });

  it('rejects integrity failures and unsupported protocols', () => {
    const tampered = encoded(); tampered.goal = { changed: true };
    assert.equal(decodeProjectStateEnvelope(tampered).errors[0].code, 'digest-mismatch');
    const protocol = encoded(); protocol.protocol = 'other.protocol';
    const resigned = encodeEnvelope({ envelope: protocol });
    assert.equal(decodeProjectStateEnvelope(resigned).errors[0].code, 'invalid-protocol');
  });
});
