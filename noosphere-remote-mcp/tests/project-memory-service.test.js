import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  InMemoryProjectMemoryRepository,
  MCP_ERROR_CODES,
  PROJECT_MEMORY_SCHEMA_VERSION,
  ProjectMemoryService,
} from '../index.js';
import { validCheckpoint } from './fixtures.js';

const ownerA = 'issuer:https://id.example|subject:user-a';
const ownerB = 'issuer:https://id.example|subject:user-b';

function harness() {
  const repository = new InMemoryProjectMemoryRepository();
  const clock = { t: Date.parse('2026-07-19T12:00:00.000Z') };
  let counter = 0;
  const service = new ProjectMemoryService({
    repository,
    now: () => new Date(clock.t).toISOString(),
    nextId: (prefix) => `${prefix}_${(counter += 1)}`,
    cursorSecret: 'test-cursor-secret',
  });
  return { repository, service, tick: (ms) => { clock.t += ms; } };
}

function isCode(code) {
  return (error) => error && error.isError === true && error.error.code === code;
}

function checkpointInput({ projectId, sessionId = null, id = 'chk_root', revision = 1, previous = null, idempotencyKey = 'save-1', currentStatus = 'Head status text.' }) {
  return {
    project_id: projectId,
    session_id: sessionId,
    checkpoint: validCheckpoint({
      id,
      project_id: projectId,
      session_id: sessionId,
      revision,
      previous_checkpoint_id: previous,
      current_status: currentStatus,
    }),
    idempotency_key: idempotencyKey,
  };
}

describe('ProjectMemoryService project lifecycle and matching', () => {
  it('creates a normalized, active project with server-owned timestamps and identity', async () => {
    const { service } = harness();
    const project = await service.createProject({ ownerScope: ownerA, input: { name: '  Bicycle   Repair  ' } });
    assert.equal(project.id, 'prj_1');
    assert.equal(project.schema_version, PROJECT_MEMORY_SCHEMA_VERSION);
    assert.equal(project.normalized_name, 'bicycle repair');
    assert.equal(project.status, 'active');
    assert.deepEqual(project.aliases, []);
    assert.equal(project.description, null);
    assert.equal(project.latest_checkpoint_id, null);
    assert.equal(project.created_at, project.last_activity_at);
  });

  it('isolates projects by owner scope', async () => {
    const { service } = harness();
    await service.createProject({ ownerScope: ownerA, input: { name: 'Only A' } });
    assert.deepEqual((await service.listProjects({ ownerScope: ownerB })).projects, []);
  });

  it('resolves exact id, resolves one exact alias after NFKC, and excludes archived matches', async () => {
    const { service } = harness();
    const project = await service.createProject({ ownerScope: ownerA, input: { name: 'Bicycle Repair', aliases: ['bike'] } });
    assert.deepEqual(await service.findProjects({ ownerScope: ownerA, input: { query: project.id } }), { result: 'resolved', project });
    assert.equal((await service.findProjects({ ownerScope: ownerA, input: { query: 'ＢＩＫＥ' } })).result, 'resolved');
    await service.archiveProject({ ownerScope: ownerA, input: { project_id: project.id } });
    assert.deepEqual(await service.findProjects({ ownerScope: ownerA, input: { query: 'bike' } }), { result: 'none', candidates: [] });
  });

  it('returns ambiguity for a single substring candidate and for duplicate normalized names', async () => {
    const { service } = harness();
    const bicycle = await service.createProject({ ownerScope: ownerA, input: { name: 'Bicycle Repair' } });
    const single = await service.findProjects({ ownerScope: ownerA, input: { query: 'bicy' } });
    assert.equal(single.result, 'ambiguous');
    assert.deepEqual(single.candidates.map(({ id }) => id), [bicycle.id]);
    assert.equal(single.candidates[0].schema_version, PROJECT_MEMORY_SCHEMA_VERSION);

    await service.createProject({ ownerScope: ownerA, input: { name: 'Bicycle Repair' } });
    assert.equal((await service.findProjects({ ownerScope: ownerA, input: { query: 'Bicycle Repair' } })).result, 'ambiguous');
  });

  it('lists newest-first, hides archived by default, and pages with a bound cursor', async () => {
    const { service, tick } = harness();
    const first = await service.createProject({ ownerScope: ownerA, input: { name: 'First' } });
    tick(1000);
    const second = await service.createProject({ ownerScope: ownerA, input: { name: 'Second' } });
    tick(1000);
    const third = await service.createProject({ ownerScope: ownerA, input: { name: 'Third' } });
    await service.archiveProject({ ownerScope: ownerA, input: { project_id: second.id } });

    const defaultView = await service.listProjects({ ownerScope: ownerA });
    assert.deepEqual(defaultView.projects.map(({ id }) => id), [third.id, first.id]);
    assert.equal(defaultView.next_cursor, null);

    const firstPage = await service.listProjects({ ownerScope: ownerA, input: { include_archived: true, limit: 1 } });
    assert.deepEqual(firstPage.projects.map(({ id }) => id), [third.id]);
    assert.ok(firstPage.next_cursor);
    const secondPage = await service.listProjects({ ownerScope: ownerA, input: { include_archived: true, limit: 1, cursor: firstPage.next_cursor } });
    assert.deepEqual(secondPage.projects.map(({ id }) => id), [second.id]);
    await assert.rejects(
      service.listProjects({ ownerScope: ownerA, input: { cursor: 'v1.not.a.cursor' } }),
      isCode(MCP_ERROR_CODES.INVALID_ARGUMENT),
    );
  });

  it('updates, archives, and deletes with not-found on missing or cross-owner records', async () => {
    const { service, tick } = harness();
    const project = await service.createProject({ ownerScope: ownerA, input: { name: 'Bicycle Repair' } });
    tick(1000);
    const updated = await service.updateProject({ ownerScope: ownerA, input: { project_id: project.id, name: 'Bike Fix', aliases: ['bike'] } });
    assert.equal(updated.name, 'Bike Fix');
    assert.equal(updated.normalized_name, 'bike fix');
    assert.notEqual(updated.updated_at, project.updated_at);
    assert.equal(updated.last_activity_at, project.last_activity_at);

    await assert.rejects(service.getProject({ ownerScope: ownerB, input: { project_id: project.id } }), isCode(MCP_ERROR_CODES.NOT_FOUND));
    await assert.rejects(service.updateProject({ ownerScope: ownerA, input: { project_id: 'prj_missing', name: 'X' } }), isCode(MCP_ERROR_CODES.NOT_FOUND));

    assert.deepEqual(await service.deleteProject({ ownerScope: ownerA, input: { project_id: project.id } }), { project_id: project.id });
    await assert.rejects(service.deleteProject({ ownerScope: ownerA, input: { project_id: project.id } }), isCode(MCP_ERROR_CODES.NOT_FOUND));
  });
});

describe('ProjectMemoryService session, checkpoint, and summary core', () => {
  it('creates active sessions with defaults and rejects unknown projects', async () => {
    const { service } = harness();
    const project = await service.createProject({ ownerScope: ownerA, input: { name: 'Bicycle Repair' } });
    const session = await service.createSession({ ownerScope: ownerA, input: { project_id: project.id, source_client: 'chatgpt' } });
    assert.equal(session.status, 'active');
    assert.equal(session.source_model, null);
    assert.deepEqual(session.metadata, { entries: [] });
    assert.equal(session.latest_checkpoint_id, null);
    await assert.rejects(
      service.createSession({ ownerScope: ownerA, input: { project_id: 'prj_missing', source_client: 'chatgpt' } }),
      isCode(MCP_ERROR_CODES.NOT_FOUND),
    );
  });

  it('treats same-state transitions as no-ops and rejects illegal ones', async () => {
    const { service, tick } = harness();
    const project = await service.createProject({ ownerScope: ownerA, input: { name: 'Bicycle Repair' } });
    const session = await service.createSession({ ownerScope: ownerA, input: { project_id: project.id, source_client: 'chatgpt' } });
    tick(5000);
    const noop = await service.transitionSession({ ownerScope: ownerA, input: { project_id: project.id, session_id: session.id, status: 'active' } });
    assert.equal(noop.updated_at, session.updated_at);
    const paused = await service.transitionSession({ ownerScope: ownerA, input: { project_id: project.id, session_id: session.id, status: 'paused' } });
    assert.equal(paused.status, 'paused');
    assert.notEqual(paused.updated_at, session.updated_at);
    await service.transitionSession({ ownerScope: ownerA, input: { project_id: project.id, session_id: session.id, status: 'completed' } });
    await assert.rejects(
      service.transitionSession({ ownerScope: ownerA, input: { project_id: project.id, session_id: session.id, status: 'active' } }),
      isCode(MCP_ERROR_CODES.CONFLICT),
    );
  });

  it('commits a linear checkpoint history, projects heads, and replays idempotently', async () => {
    const { service } = harness();
    const project = await service.createProject({ ownerScope: ownerA, input: { name: 'Bicycle Repair' } });
    const session = await service.createSession({ ownerScope: ownerA, input: { project_id: project.id, source_client: 'chatgpt' } });

    const root = checkpointInput({ projectId: project.id, sessionId: session.id, id: 'chk_root', idempotencyKey: 'save-root' });
    const saved = await service.saveCheckpoint({ ownerScope: ownerA, input: root });
    assert.equal(saved.checkpoint.id, 'chk_root');
    assert.equal(saved.deduplicated, false);

    const latest = await service.getLatestCheckpoint({ ownerScope: ownerA, input: { project_id: project.id } });
    assert.equal(latest.checkpoint.id, 'chk_root');
    assert.equal(latest.content_trust, 'untrusted-persisted-data');
    assert.equal((await service.getProject({ ownerScope: ownerA, input: { project_id: project.id } })).latest_checkpoint_id, 'chk_root');
    assert.equal((await service.getSession({ ownerScope: ownerA, input: { project_id: project.id, session_id: session.id } })).latest_checkpoint_id, 'chk_root');

    assert.equal((await service.saveCheckpoint({ ownerScope: ownerA, input: root })).deduplicated, true);
    await assert.rejects(
      service.saveCheckpoint({ ownerScope: ownerA, input: checkpointInput({ projectId: project.id, sessionId: session.id, id: 'chk_other', idempotencyKey: 'save-root', currentStatus: 'different' }) }),
      isCode(MCP_ERROR_CODES.IDEMPOTENCY_CONFLICT),
    );

    const two = checkpointInput({ projectId: project.id, sessionId: session.id, id: 'chk_two', revision: 2, previous: 'chk_root', idempotencyKey: 'save-two' });
    assert.equal((await service.saveCheckpoint({ ownerScope: ownerA, input: two })).checkpoint.revision, 2);
    const listed = await service.listCheckpoints({ ownerScope: ownerA, input: { project_id: project.id } });
    assert.deepEqual(listed.checkpoints.map(({ id }) => id), ['chk_two', 'chk_root']);
    assert.equal(listed.content_trust, 'untrusted-persisted-data');
  });

  it('rejects a stale revision-one root once a head exists', async () => {
    const { service } = harness();
    const project = await service.createProject({ ownerScope: ownerA, input: { name: 'Bicycle Repair' } });
    await service.saveCheckpoint({ ownerScope: ownerA, input: checkpointInput({ projectId: project.id, id: 'chk_root', idempotencyKey: 'save-root' }) });
    await assert.rejects(
      service.saveCheckpoint({ ownerScope: ownerA, input: checkpointInput({ projectId: project.id, id: 'chk_second', idempotencyKey: 'save-second' }) }),
      isCode(MCP_ERROR_CODES.CONFLICT),
    );
  });

  it('summarizes counts and the committed head status', async () => {
    const { service } = harness();
    const project = await service.createProject({ ownerScope: ownerA, input: { name: 'Bicycle Repair' } });
    const session = await service.createSession({ ownerScope: ownerA, input: { project_id: project.id, source_client: 'chatgpt' } });
    await service.saveCheckpoint({ ownerScope: ownerA, input: checkpointInput({ projectId: project.id, sessionId: session.id, id: 'chk_root', idempotencyKey: 'save-root', currentStatus: 'Diagnosing brakes.' }) });
    const summary = await service.getProjectSummary({ ownerScope: ownerA, input: { project_id: project.id } });
    assert.deepEqual(summary.summary, {
      schema_version: PROJECT_MEMORY_SCHEMA_VERSION,
      current_status: 'Diagnosing brakes.',
      checkpoint_count: 1,
      session_count: 1,
      latest_checkpoint_id: 'chk_root',
    });
    assert.equal(summary.content_trust, 'untrusted-persisted-data');
  });
});

describe('ProjectMemoryService continuity acceptance', () => {
  it('resumes Bicycle Repair without selecting ESS Design', async () => {
    const { service } = harness();
    const bicycle = await service.createProject({ ownerScope: ownerA, input: { name: 'Bicycle Repair' } });
    const ess = await service.createProject({ ownerScope: ownerA, input: { name: 'ESS Design' } });
    const session = await service.createSession({ ownerScope: ownerA, input: { project_id: bicycle.id, source_client: 'chatgpt' } });
    await service.saveCheckpoint({ ownerScope: ownerA, input: checkpointInput({ projectId: bicycle.id, sessionId: session.id, id: 'chk_root', idempotencyKey: 'save-root' }) });

    const resumed = await service.resumeProject({ ownerScope: ownerA, input: { project_id: bicycle.id } });
    assert.equal(resumed.latest_checkpoint.project_id, bicycle.id);
    assert.equal((await service.findProjects({ ownerScope: ownerA, input: { query: 'design' } })).result, 'ambiguous');
    assert.notEqual(bicycle.id, ess.id);
  });
});
