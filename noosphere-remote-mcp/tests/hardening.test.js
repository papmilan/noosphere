import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CHECKPOINT_SCHEMA,
  InMemoryProjectMemoryRepository,
  MCP_TOOLS,
  SESSION_SCHEMA,
  validateSaveCheckpointInput,
  validateSession,
} from '../index.js';
import { validCheckpoint, validProject, validSession } from './fixtures.js';

const ownerA = 'issuer:https://id.example|subject:user-a';
const ownerB = 'issuer:https://id.example|subject:user-b';

function assertClosedObjects(schema, path = 'root') {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type === 'object') {
    assert.equal(schema.additionalProperties, false, `${path} must reject unknown fields`);
    assert.ok(schema.properties, `${path} must define bounded properties`);
  }
  for (const [name, child] of Object.entries(schema.properties ?? {})) assertClosedObjects(child, `${path}.${name}`);
  for (const [index, child] of (schema.items ? [schema.items] : []).entries()) assertClosedObjects(child, `${path}.items[${index}]`);
  for (const [name, children] of Object.entries({ anyOf: schema.anyOf, oneOf: schema.oneOf, allOf: schema.allOf })) {
    for (const [index, child] of (children ?? []).entries()) assertClosedObjects(child, `${path}.${name}[${index}]`);
  }
}

function idempotency(key, requestHash) {
  return { key, requestHash };
}

function revisionTwo(overrides = {}) {
  return validCheckpoint({
    id: 'chk_01j3bicycle_r2',
    revision: 2,
    previous_checkpoint_id: 'chk_01j3bicycle',
    ...overrides,
  });
}

describe('public MCP schema hardening', () => {
  it('embeds only closed, bounded object schemas in every public MCP input and output', () => {
    for (const [name, tool] of Object.entries(MCP_TOOLS)) {
      assertClosedObjects(tool.input, `${name}.input`);
      assertClosedObjects(tool.output, `${name}.output`);
    }
    assertClosedObjects(SESSION_SCHEMA);
    assertClosedObjects(CHECKPOINT_SCHEMA);
  });

  it('rejects forbidden identity and authentication keys at every metadata depth', () => {
    for (const forbidden of ['owner', 'tenant', 'user', 'subject', 'token', 'authorization']) {
      const metadata = {
        entries: [{
          key: 'display',
          value: {
            kind: 'record',
            entries: [{ key: forbidden, value: { kind: 'string', value: 'private' } }],
          },
        }],
      };
      assert.throws(() => validateSession(validSession({ metadata })), /forbidden-metadata-key/);
    }
  });

  it('rejects malformed nested metadata and forbidden checkpoint-wrapper fields', () => {
    assert.throws(
      () => validateSession(validSession({ metadata: { entries: [{ key: 'ok', value: { kind: 'record', owner: 'x' } }] } })),
      /unknown-field:metadata-value/,
    );
    assert.throws(
      () => validateSession(validSession({ metadata: { entries: [{ key: 'token', value: { kind: 'string', value: 'x' } }] } })),
      /forbidden-metadata-key/,
    );
    assert.throws(
      () => validateSaveCheckpointInput({ project_id: 'prj_01j3bicycle', checkpoint: validCheckpoint(), idempotency_key: 'save-1', owner: 'x' }),
      /unknown-field:owner/,
    );
    assert.throws(
      () => validateSaveCheckpointInput({ project_id: 'prj_01j3bicycle', checkpoint: validCheckpoint({ authorization: 'Bearer x' }), idempotency_key: 'save-1' }),
      /unknown-field:authorization/,
    );
  });

  it('uses status as the sole project lifecycle state', async () => {
    const project = validProject({ status: 'archived' });
    const repository = new InMemoryProjectMemoryRepository();
    await repository.createProject({ ownerScope: ownerA, project });
    await assert.rejects(
      repository.createProject({ ownerScope: ownerA, project: validProject({ id: 'prj_archived', archived: true }) }),
      /unknown-field:archived/,
    );
  });
});

describe('in-memory repository hardening', () => {
  it('fails closed with a structured conflict when a checkpoint ID already exists', async () => {
    const repository = new InMemoryProjectMemoryRepository();
    await repository.createProject({ ownerScope: ownerA, project: validProject() });
    await repository.saveCheckpoint({ ownerScope: ownerA, checkpoint: validCheckpoint(), idempotency: idempotency('one', 'hash-one') });
    await assert.rejects(
      repository.saveCheckpoint({ ownerScope: ownerA, checkpoint: validCheckpoint({ goal: 'Changed.' }), idempotency: idempotency('two', 'hash-two') }),
      (error) => error.code === 'checkpoint-conflict' && error.status === 409,
    );
  });

  it('requires a strictly linear, same-owner, same-project checkpoint predecessor', async () => {
    const repository = new InMemoryProjectMemoryRepository();
    await repository.createProject({ ownerScope: ownerA, project: validProject() });
    await repository.createProject({ ownerScope: ownerA, project: validProject({ id: 'prj_other', name: 'Other Project', normalized_name: 'other project' }) });
    await repository.createProject({ ownerScope: ownerB, project: validProject() });
    await repository.saveCheckpoint({ ownerScope: ownerA, checkpoint: validCheckpoint(), idempotency: idempotency('one', 'hash-one') });
    await repository.saveCheckpoint({ ownerScope: ownerA, checkpoint: validCheckpoint({ id: 'chk_other', project_id: 'prj_other' }), idempotency: idempotency('other', 'hash-other') });
    await repository.saveCheckpoint({ ownerScope: ownerB, checkpoint: validCheckpoint({ id: 'chk_owner_b' }), idempotency: idempotency('owner-b', 'hash-owner-b') });

    await assert.rejects(
      repository.saveCheckpoint({ ownerScope: ownerA, checkpoint: revisionTwo({ previous_checkpoint_id: 'chk_missing' }), idempotency: idempotency('missing', 'hash-missing') }),
      (error) => error.code === 'checkpoint-predecessor-not-found',
    );
    await assert.rejects(
      repository.saveCheckpoint({ ownerScope: ownerA, checkpoint: revisionTwo({ previous_checkpoint_id: 'chk_owner_b' }), idempotency: idempotency('cross-owner', 'hash-cross-owner') }),
      (error) => error.code === 'checkpoint-predecessor-not-found',
    );
    await assert.rejects(
      repository.saveCheckpoint({ ownerScope: ownerA, checkpoint: revisionTwo({ previous_checkpoint_id: 'chk_other' }), idempotency: idempotency('cross-project', 'hash-cross-project') }),
      (error) => error.code === 'checkpoint-predecessor-conflict',
    );
    await assert.rejects(
      repository.saveCheckpoint({ ownerScope: ownerA, checkpoint: revisionTwo({ previous_checkpoint_id: 'chk_01j3bicycle', revision: 3 }), idempotency: idempotency('skipped', 'hash-skipped') }),
      (error) => error.code === 'checkpoint-revision-conflict',
    );
    await repository.saveCheckpoint({ ownerScope: ownerA, checkpoint: revisionTwo(), idempotency: idempotency('two', 'hash-two') });
    await assert.rejects(
      repository.saveCheckpoint({ ownerScope: ownerA, checkpoint: validCheckpoint({ id: 'chk_branch', revision: 2, previous_checkpoint_id: 'chk_01j3bicycle' }), idempotency: idempotency('branch', 'hash-branch') }),
      (error) => error.code === 'checkpoint-predecessor-conflict',
    );
  });

  it('scopes idempotency by owner, operation, and key', async () => {
    const repository = new InMemoryProjectMemoryRepository();
    assert.equal((await repository.recordIdempotency({ ownerScope: ownerA, operation: 'save_checkpoint', key: 'shared', requestHash: 'hash-a', result: { accepted: true } })).deduplicated, false);
    assert.equal((await repository.recordIdempotency({ ownerScope: ownerA, operation: 'create_project', key: 'shared', requestHash: 'hash-b', result: { accepted: true } })).deduplicated, false);
    assert.equal((await repository.recordIdempotency({ ownerScope: ownerB, operation: 'save_checkpoint', key: 'shared', requestHash: 'hash-c', result: { accepted: true } })).deduplicated, false);
    assert.equal((await repository.recordIdempotency({ ownerScope: ownerA, operation: 'save_checkpoint', key: 'shared', requestHash: 'hash-a', result: { accepted: true } })).deduplicated, true);
    await assert.rejects(
      repository.recordIdempotency({ ownerScope: ownerA, operation: 'save_checkpoint', key: 'shared', requestHash: 'other', result: { accepted: true } }),
      (error) => error.code === 'idempotency-conflict',
    );
  });
});
