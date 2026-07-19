import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CHECKPOINT_SCHEMA,
  PROJECT_MEMORY_LIMITS,
  PROJECT_MEMORY_SCHEMA_VERSION,
  PROJECT_RECORD_SCHEMA,
  PROJECT_SCHEMA,
  SESSION_SCHEMA,
  validateCheckpoint,
  validateProject,
  validateSession,
} from '../index.js';
import { validCheckpoint, validProject, validSession } from './fixtures.js';

describe('Project Memory versioned schemas', () => {
  it('publishes independent project, session, and checkpoint schemas', () => {
    assert.equal(PROJECT_MEMORY_SCHEMA_VERSION, 'noosphere.project-memory/1.0.0');
    assert.equal(PROJECT_SCHEMA.properties.schema_version.const, PROJECT_MEMORY_SCHEMA_VERSION);
    assert.ok(PROJECT_RECORD_SCHEMA.required.includes('owner_scope'));
    assert.equal(SESSION_SCHEMA.properties.schema_version.const, PROJECT_MEMORY_SCHEMA_VERSION);
    assert.equal(CHECKPOINT_SCHEMA.properties.schema_version.const, PROJECT_MEMORY_SCHEMA_VERSION);
    assert.equal(CHECKPOINT_SCHEMA.additionalProperties, false);
  });

  it('accepts bounded user-visible project, session, and checkpoint state', () => {
    assert.deepEqual(validateProject(validProject()), validProject());
    assert.deepEqual(validateSession(validSession()), validSession());
    assert.deepEqual(validateCheckpoint(validCheckpoint()), validCheckpoint());
  });

  it('rejects hidden reasoning, transcripts, and arbitrary extension fields', () => {
    assert.throws(
      () => validateCheckpoint(validCheckpoint({ hidden_chain_of_thought: 'private' })),
      /unknown-field:hidden_chain_of_thought/,
    );
    assert.throws(
      () => validateCheckpoint(validCheckpoint({ transcript: 'entire conversation' })),
      /unknown-field:transcript/,
    );
    assert.throws(
      () => validateCheckpoint(validCheckpoint({ extensions: { dangerous: true } })),
      /unknown-field:extensions/,
    );
  });

  it('rejects overlong fields, oversized arrays, oversized payloads, and controls', () => {
    assert.throws(
      () => validateProject(validProject({ name: 'x'.repeat(PROJECT_MEMORY_LIMITS.projectNameChars + 1) })),
      /string-limit:name/,
    );
    assert.throws(
      () => validateCheckpoint(validCheckpoint({ decisions: Array(PROJECT_MEMORY_LIMITS.itemsPerSection + 1).fill('decision') })),
      /array-limit:decisions/,
    );
    assert.throws(
      () => validateCheckpoint(validCheckpoint({ source_summary: 'x'.repeat(PROJECT_MEMORY_LIMITS.checkpointBytes) })),
      /payload-limit/,
    );
    assert.throws(
      () => validateSession(validSession({ source_client: 'client\u0000name' })),
      /control-character:source_client/,
    );
  });

  it('rejects inconsistent revision and predecessor relationships', () => {
    assert.throws(
      () => validateCheckpoint(validCheckpoint({ previous_checkpoint_id: 'chk_previous' })),
      /revision-predecessor/,
    );
    assert.throws(
      () => validateCheckpoint(validCheckpoint({ revision: 2, previous_checkpoint_id: null })),
      /revision-predecessor/,
    );
    assert.throws(
      () => validateCheckpoint(validCheckpoint({ revision: 2, previous_checkpoint_id: 'chk_01j3bicycle' })),
      /revision-predecessor/,
    );
  });
});
