import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  InMemoryProjectMemoryRepository,
  MCP_ERROR_CODES,
  MCP_TOOLS,
  assessResumeFreshness,
  createMcpError,
} from '../index.js';
import { validCheckpoint, validProject } from './validation.test.js';

describe('Project Memory MCP contracts', () => {
  it('exposes the small approved tool surface without identity-bearing arguments', () => {
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
      'update_project',
    ]);
    assert.equal(/owner|tenant|subject|authorization|token|user_id/i.test(JSON.stringify(MCP_TOOLS)), false);
    assert.equal(MCP_TOOLS.resume_project.output.properties.content_trust.const, 'untrusted-persisted-data');
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
    await repository.createProject({ ownerScope, project: validProject() });
    const checkpoint = validCheckpoint();
    const first = await repository.saveCheckpoint({
      ownerScope,
      checkpoint,
      idempotency: { key: 'save-1', requestHash: 'sha256:request-a' },
    });
    const repeated = await repository.saveCheckpoint({
      ownerScope,
      checkpoint,
      idempotency: { key: 'save-1', requestHash: 'sha256:request-a' },
    });
    assert.equal(first.deduplicated, false);
    assert.equal(repeated.deduplicated, true);
    await assert.rejects(
      repository.saveCheckpoint({
        ownerScope,
        checkpoint,
        idempotency: { key: 'save-1', requestHash: 'sha256:different' },
      }),
      /idempotency-conflict/,
    );
  });
});
