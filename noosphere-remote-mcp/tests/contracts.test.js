import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  InMemoryProjectMemoryRepository,
  MCP_ERROR_CODES,
  MCP_TOOLS,
  assessResumeFreshness,
  createFreshnessWarning,
  createMcpError,
} from '../index.js';
import { validCheckpoint, validProject, validSession } from './fixtures.js';

function matchesSchema(schema, value, root = schema) {
  if (schema.$ref) return matchesSchema(root.$defs[schema.$ref.slice('#/$defs/'.length)], value, root);
  if (schema.allOf && !schema.allOf.every((part) => matchesSchema(part, value, root))) return false;
  if (schema.oneOf && schema.oneOf.filter((part) => matchesSchema(part, value, root)).length !== 1) return false;
  if (schema.const !== undefined && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => (type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? value && typeof value === 'object' && !Array.isArray(value) : typeof value === type))) return false;
  }
  if (schema.pattern && (typeof value !== 'string' || !new RegExp(schema.pattern).test(value))) return false;
  if (schema.minLength !== undefined && typeof value === 'string' && value.length < schema.minLength) return false;
  if (schema.maxLength !== undefined && typeof value === 'string' && value.length > schema.maxLength) return false;
  if (schema.type === 'array' && schema.maxItems !== undefined && value.length > schema.maxItems) return false;
  if (schema.type === 'array' && schema.items && !value.every((item) => matchesSchema(schema.items, item, root))) return false;
  if (schema.type === 'object') {
    if (!schema.required.every((key) => key in value)) return false;
    if (schema.additionalProperties === false && Object.keys(value).some((key) => !(key in schema.properties))) return false;
    if (!Object.entries(schema.properties).every(([key, child]) => !(key in value) || matchesSchema(child, value[key], root))) return false;
  }
  return true;
}

describe('Project Memory MCP contracts', () => {
  it('exposes the small approved tool surface', () => {
    assert.deepEqual(Object.keys(MCP_TOOLS).sort(), [
      'archive_project',
      'create_project',
      'create_session',
      'find_projects',
      'get_checkpoint',
      'get_latest_checkpoint',
      'get_project',
      'get_project_summary',
      'get_session',
      'list_checkpoints',
      'list_project_sessions',
      'list_projects',
      'resume_project',
      'save_checkpoint',
      'transition_session',
      'update_project',
    ]);
    assert.equal(MCP_TOOLS.resume_project.output.properties.content_trust.const, 'untrusted-persisted-data');
    assert.deepEqual(MCP_TOOLS.transition_session.input.properties.status.enum, [
      'active', 'paused', 'interrupted', 'completed', 'archived',
    ]);
  });

  it('makes ambiguity explicit in find-projects and never encodes a selected project', () => {
    const result = MCP_TOOLS.find_projects.output.oneOf.find((schema) => schema.properties?.result?.const === 'ambiguous');
    assert.ok(result);
    assert.ok(result.required.includes('candidates'));
    assert.equal('project' in result.properties, false);
  });

  it('uses the same bounded cursor pagination inputs on every list tool', () => {
    for (const tool of ['list_projects', 'list_project_sessions', 'list_checkpoints']) {
      assert.ok(MCP_TOOLS[tool].input.properties.cursor, tool);
      assert.equal(MCP_TOOLS[tool].input.properties.limit.maximum, 100, tool);
    }
  });

  it('reports structured stable errors without sensitive details', () => {
    assert.deepEqual(createMcpError('not-found'), {
      isError: true,
      error: { code: MCP_ERROR_CODES.NOT_FOUND, retryable: false },
    });
    assert.throws(() => createMcpError('not-a-contract-error'), /unknown-error-contract/);
  });

  it('returns explicit incomplete state warnings for interrupted and unsaved activity', () => {
    const result = assessResumeFreshness({
      latestSessionActivityAt: '2026-07-19T12:05:00.000Z',
      latestCheckpointAt: '2026-07-19T12:00:00.000Z',
      sessionStatus: 'interrupted',
    });
    assert.deepEqual(result.warnings.map(({ code }) => code), [
      'interrupted-session',
      'checkpoint-predates-session',
    ]);
    assert.equal(result.freshness, 'incomplete');
  });

  it('represents all approved freshness outcomes', () => {
    const timestamp = '2026-07-19T12:00:00.000Z';
    const later = '2026-07-19T12:05:00.000Z';
    const cases = [
      assessResumeFreshness({}),
      assessResumeFreshness({ latestCheckpointAt: timestamp, latestSessionActivityAt: later }),
      assessResumeFreshness({ sessionStatus: 'interrupted' }),
      { freshness: 'incomplete', warnings: [createFreshnessWarning('repository-state-inconsistent', 'The durable project state is incomplete and cannot be safely resumed.')] },
    ];
    const codes = MCP_TOOLS.resume_project.output.properties.warnings.items.properties.code.enum;
    assert.deepEqual(codes, ['interrupted-session', 'checkpoint-predates-session', 'no-durable-checkpoint', 'repository-state-inconsistent']);
    for (const { warnings } of cases) for (const warning of warnings) assert.equal(matchesSchema(MCP_TOOLS.resume_project.output.properties.warnings.items, warning), true);
  });
});

describe('In-memory Project Memory repository contract', () => {
  it('requires server-derived owner scope and prevents a second owner reading a project ID', async () => {
    const repository = new InMemoryProjectMemoryRepository();
    await assert.rejects(
      repository.createProject({ project: validProject() }),
      /invalid-owner-scope/,
    );
    await repository.createProject({
      ownerScope: 'issuer:https://id.example|subject:user-a',
      project: validProject(),
    });
    assert.deepEqual(
      await repository.getProject({
        ownerScope: 'issuer:https://id.example|subject:user-a',
        projectId: 'prj_01j3bicycle',
      }),
      validProject(),
    );
    assert.equal(
      await repository.getProject({
        ownerScope: 'issuer:https://id.example|subject:user-b',
        projectId: 'prj_01j3bicycle',
      }),
      null,
    );
  });

  it('keeps checkpoint writes owner-scoped and idempotency keys conflict-safe', async () => {
    const repository = new InMemoryProjectMemoryRepository();
    const ownerScope = 'issuer:https://id.example|subject:user-a';
    const project = validProject();
    const session = validSession();
    await repository.createProject({ ownerScope, project });
    await repository.createSession({ ownerScope, session });
    const checkpoint = validCheckpoint();
    const projectedProject = { ...project, latest_checkpoint_id: checkpoint.id };
    const projectedSession = { ...session, latest_checkpoint_id: checkpoint.id };
    const first = await repository.saveCheckpoint({
      ownerScope,
      checkpoint,
      project: projectedProject,
      session: projectedSession,
      idempotency: { key: 'save-1', requestHash: 'sha256:request-a' },
    });
    const repeated = await repository.saveCheckpoint({
      ownerScope,
      checkpoint,
      project: projectedProject,
      session: projectedSession,
      idempotency: { key: 'save-1', requestHash: 'sha256:request-a' },
    });
    assert.equal(first.deduplicated, false);
    assert.equal(repeated.deduplicated, true);
    await assert.rejects(
      repository.saveCheckpoint({
        ownerScope,
        checkpoint,
        project: projectedProject,
        session: projectedSession,
        idempotency: { key: 'save-1', requestHash: 'sha256:different' },
      }),
      /idempotency-conflict/,
    );
  });
});
