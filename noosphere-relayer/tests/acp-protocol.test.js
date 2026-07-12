import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodeEnvelope } from '@noosphere/acp-protocol';
import { decodeProjectStateEnvelope } from '../acp-protocol.js';

const required = {
  protocol: 'acp.project-state-envelope', schema_version: '1.0.0', snapshot_id: '',
  created_at: '2026-07-12T00:00:00.000Z', origin: {}, integrity: { algorithm: 'sha256', digest: '', signature: {} },
  permission_scope: 'project', trust: {}, repository: {}, phase: 'implementation', goal: {}, plan: [],
  completed_work: [], decisions: [], evidence: [], assumptions: [], rejected_approaches: [], unknowns: [],
  blockers: [], risks: [], conflicts: [], working_stance: {}, next_actions: [], references: [], extensions: {},
};
const encoded = () => encodeEnvelope({ envelope: structuredClone(required) });

describe('relayer ACP protocol boundary', () => {
  it('uses shared wire decoding and accepts required protocol fields', () => {
    assert.equal(decodeProjectStateEnvelope(JSON.stringify(encoded())).ok, true);
  });

  it('rejects missing required fields and unsupported versions', () => {
    const missing = encoded(); delete missing.goal;
    const resignedMissing = encodeEnvelope({ envelope: missing });
    assert.equal(decodeProjectStateEnvelope(resignedMissing).errors[0].code, 'missing-required-field');
    const version = encoded(); version.schema_version = '2.0.0';
    const resigned = encodeEnvelope({ envelope: version });
    assert.equal(decodeProjectStateEnvelope(resigned).errors[0].code, 'unsupported-version');
  });

  it('rejects integrity failures and unsupported protocols', () => {
    const tampered = encoded(); tampered.goal = { changed: true };
    assert.equal(decodeProjectStateEnvelope(tampered).errors[0].code, 'digest-mismatch');
    const protocol = encoded(); protocol.protocol = 'other.protocol';
    const resigned = encodeEnvelope({ envelope: protocol });
    assert.equal(decodeProjectStateEnvelope(resigned).errors[0].code, 'invalid-protocol');
  });
});
