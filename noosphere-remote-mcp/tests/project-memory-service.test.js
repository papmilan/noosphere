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

function harness(repository = new InMemoryProjectMemoryRepository()) {
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

class PausingSaveRepository extends InMemoryProjectMemoryRepository {
  #release;

  constructor() {
    super();
    this.saveStarted = new Promise((resolve) => { this.onSaveStarted = resolve; });
    this.saveReleased = new Promise((resolve) => { this.#release = resolve; });
  }

  releaseSave() { this.#release(); }

  async saveCheckpoint(args) {
    this.onSaveStarted();
    await this.saveReleased;
    return super.saveCheckpoint(args);
  }
}

class BarrierReadRepository extends InMemoryProjectMemoryRepository {
  #projectGate = null;
  #projectReads = 0;
  #sessionGate = null;
  #sessionReads = 0;

  blockNextProjectReads(count = 2) {
    let release;
    const promise = new Promise((resolve) => { release = resolve; });
    this.#projectGate = { count, promise, release };
  }

  blockNextSessionReads(count = 2) {
    let release;
    const promise = new Promise((resolve) => { release = resolve; });
    this.#sessionGate = { count, promise, release };
  }

  async getProject(args) {
    const value = await super.getProject(args);
    const gate = this.#projectGate;
    if (!gate) return value;
    this.#projectReads += 1;
    if (this.#projectReads === gate.count) gate.release();
    await gate.promise;
    return value;
  }

  async getSession(args) {
    const value = await super.getSession(args);
    const gate = this.#sessionGate;
    if (!gate) return value;
    this.#sessionReads += 1;
    if (this.#sessionReads === gate.count) gate.release();
    await gate.promise;
    return value;
  }
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

  it('rejects undeclared fields and invalid collection/page shapes without writing', async () => {
    const { service } = harness();

    await assert.rejects(
      service.createProject({
        ownerScope: ownerA,
        input: { name: 'Must Not Exist', aliases: 'not-an-array', owner: ownerB },
      }),
      isCode(MCP_ERROR_CODES.INVALID_ARGUMENT),
    );
    for (const limit of [0, 101, '10']) {
      await assert.rejects(
        service.listProjects({ ownerScope: ownerA, input: { limit } }),
        isCode(MCP_ERROR_CODES.INVALID_ARGUMENT),
      );
    }
    await assert.rejects(
      service.listProjects({ ownerScope: ownerA, input: { unexpected: true } }),
      isCode(MCP_ERROR_CODES.INVALID_ARGUMENT),
    );
    assert.deepEqual((await service.listProjects({ ownerScope: ownerA })).projects, []);
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
    assert.deepEqual(firstPage.projects.map(({ id }) => id), [second.id]);
    assert.ok(firstPage.next_cursor);
    const secondPage = await service.listProjects({ ownerScope: ownerA, input: { include_archived: true, limit: 1, cursor: firstPage.next_cursor } });
    assert.deepEqual(secondPage.projects.map(({ id }) => id), [third.id]);
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
    assert.equal(updated.last_activity_at, updated.updated_at);

    await assert.rejects(service.getProject({ ownerScope: ownerB, input: { project_id: project.id } }), isCode(MCP_ERROR_CODES.NOT_FOUND));
    await assert.rejects(service.updateProject({ ownerScope: ownerA, input: { project_id: 'prj_missing', name: 'X' } }), isCode(MCP_ERROR_CODES.NOT_FOUND));

    assert.deepEqual(await service.deleteProject({ ownerScope: ownerA, input: { project_id: project.id } }), { project_id: project.id });
    await assert.rejects(service.deleteProject({ ownerScope: ownerA, input: { project_id: project.id } }), isCode(MCP_ERROR_CODES.NOT_FOUND));
  });

  it('rejects one of two concurrent project updates instead of silently losing it', async () => {
    const repository = new BarrierReadRepository();
    const { service, tick } = harness(repository);
    const project = await service.createProject({ ownerScope: ownerA, input: { name: 'Original' } });
    tick(1_000);
    repository.blockNextProjectReads();

    const results = await Promise.allSettled([
      service.updateProject({ ownerScope: ownerA, input: { project_id: project.id, name: 'First' } }),
      service.updateProject({ ownerScope: ownerA, input: { project_id: project.id, name: 'Second' } }),
    ]);

    assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
    assert.equal(results.filter(({ status }) => status === 'rejected').length, 1);
    assert.equal(isCode(MCP_ERROR_CODES.CONFLICT)(results.find(({ status }) => status === 'rejected').reason), true);
  });
});

describe('ProjectMemoryService session, checkpoint, and summary core', () => {
  it('creates active sessions with defaults, advances project activity, and rejects unknown projects', async () => {
    const { service, tick } = harness();
    const project = await service.createProject({ ownerScope: ownerA, input: { name: 'Bicycle Repair' } });
    tick(1000);
    const session = await service.createSession({ ownerScope: ownerA, input: { project_id: project.id, source_client: 'chatgpt' } });
    assert.equal(session.status, 'active');
    assert.equal(session.source_model, null);
    assert.deepEqual(session.metadata, { entries: [] });
    assert.equal(session.latest_checkpoint_id, null);
    const afterSession = await service.getProject({ ownerScope: ownerA, input: { project_id: project.id } });
    assert.equal(afterSession.updated_at, session.created_at);
    assert.equal(afterSession.last_activity_at, session.created_at);
    await assert.rejects(
      service.createSession({ ownerScope: ownerA, input: { project_id: 'prj_missing', source_client: 'chatgpt' } }),
      isCode(MCP_ERROR_CODES.NOT_FOUND),
    );
  });

  it('rejects explicit null metadata and unknown session fields without writing', async () => {
    const { service } = harness();
    const project = await service.createProject({ ownerScope: ownerA, input: { name: 'Repair' } });

    await assert.rejects(
      service.createSession({
        ownerScope: ownerA,
        input: { project_id: project.id, source_client: 'chatgpt', metadata: null },
      }),
      isCode(MCP_ERROR_CODES.INVALID_ARGUMENT),
    );
    await assert.rejects(
      service.createSession({
        ownerScope: ownerA,
        input: { project_id: project.id, source_client: 'chatgpt', authorization: 'secret' },
      }),
      isCode(MCP_ERROR_CODES.INVALID_ARGUMENT),
    );
    assert.deepEqual(
      (await service.listProjectSessions({ ownerScope: ownerA, input: { project_id: project.id } })).sessions,
      [],
    );
  });

  it('treats same-state transitions as no-ops and rejects illegal ones', async () => {
    const { service, tick } = harness();
    const project = await service.createProject({ ownerScope: ownerA, input: { name: 'Bicycle Repair' } });
    const session = await service.createSession({ ownerScope: ownerA, input: { project_id: project.id, source_client: 'chatgpt' } });
    tick(5000);
    const beforeNoop = await service.getProject({ ownerScope: ownerA, input: { project_id: project.id } });
    const noop = await service.transitionSession({ ownerScope: ownerA, input: { project_id: project.id, session_id: session.id, status: 'active' } });
    assert.equal(noop.updated_at, session.updated_at);
    assert.deepEqual(await service.getProject({ ownerScope: ownerA, input: { project_id: project.id } }), beforeNoop);
    const paused = await service.transitionSession({ ownerScope: ownerA, input: { project_id: project.id, session_id: session.id, status: 'paused' } });
    assert.equal(paused.status, 'paused');
    assert.notEqual(paused.updated_at, session.updated_at);
    const afterPause = await service.getProject({ ownerScope: ownerA, input: { project_id: project.id } });
    assert.equal(afterPause.updated_at, paused.updated_at);
    assert.equal(afterPause.last_activity_at, paused.updated_at);
    await service.transitionSession({ ownerScope: ownerA, input: { project_id: project.id, session_id: session.id, status: 'completed' } });
    await assert.rejects(
      service.transitionSession({ ownerScope: ownerA, input: { project_id: project.id, session_id: session.id, status: 'active' } }),
      isCode(MCP_ERROR_CODES.CONFLICT),
    );
    await assert.rejects(
      service.transitionSession({ ownerScope: ownerA, input: { project_id: project.id, session_id: session.id, status: 'not-a-status' } }),
      isCode(MCP_ERROR_CODES.INVALID_ARGUMENT),
    );
  });

  it('rejects a stale concurrent session transition instead of reverting lifecycle state', async () => {
    const repository = new BarrierReadRepository();
    const { service, tick } = harness(repository);
    const project = await service.createProject({ ownerScope: ownerA, input: { name: 'Repair' } });
    const session = await service.createSession({ ownerScope: ownerA, input: { project_id: project.id, source_client: 'claude' } });
    tick(1_000);
    repository.blockNextSessionReads();

    const results = await Promise.allSettled([
      service.transitionSession({ ownerScope: ownerA, input: { project_id: project.id, session_id: session.id, status: 'paused' } }),
      service.transitionSession({ ownerScope: ownerA, input: { project_id: project.id, session_id: session.id, status: 'completed' } }),
    ]);

    assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
    assert.equal(results.filter(({ status }) => status === 'rejected').length, 1);
    assert.equal(isCode(MCP_ERROR_CODES.CONFLICT)(results.find(({ status }) => status === 'rejected').reason), true);
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
    const sameEffectiveRequest = structuredClone(root);
    sameEffectiveRequest.checkpoint.created_at = '2099-01-01T00:00:00.000Z';
    assert.equal(
      (await service.saveCheckpoint({ ownerScope: ownerA, input: sameEffectiveRequest })).deduplicated,
      true,
      'an ignored client timestamp must not turn an identical retry into a conflict',
    );
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

  it('preserves a project update that commits while a checkpoint save is waiting', async () => {
    const repository = new PausingSaveRepository();
    const { service, tick } = harness(repository);
    const project = await service.createProject({ ownerScope: ownerA, input: { name: 'Old Name' } });
    const pendingSave = service.saveCheckpoint({
      ownerScope: ownerA,
      input: checkpointInput({ projectId: project.id, id: 'chk_root', idempotencyKey: 'save-root' }),
    });
    await repository.saveStarted;

    tick(1000);
    await service.updateProject({ ownerScope: ownerA, input: { project_id: project.id, name: 'New Name' } });
    repository.releaseSave();
    await pendingSave;

    const stored = await service.getProject({ ownerScope: ownerA, input: { project_id: project.id } });
    assert.equal(stored.name, 'New Name');
    assert.equal(stored.latest_checkpoint_id, 'chk_root');
  });

  it('preserves a session transition that commits while a checkpoint save is waiting', async () => {
    const repository = new PausingSaveRepository();
    const { service, tick } = harness(repository);
    const project = await service.createProject({ ownerScope: ownerA, input: { name: 'Repair' } });
    const session = await service.createSession({ ownerScope: ownerA, input: { project_id: project.id, source_client: 'chatgpt' } });
    const pendingSave = service.saveCheckpoint({
      ownerScope: ownerA,
      input: checkpointInput({ projectId: project.id, sessionId: session.id, id: 'chk_root', idempotencyKey: 'save-root' }),
    });
    await repository.saveStarted;

    tick(1000);
    await service.transitionSession({
      ownerScope: ownerA,
      input: { project_id: project.id, session_id: session.id, status: 'paused' },
    });
    repository.releaseSave();
    await pendingSave;

    const stored = await service.getSession({
      ownerScope: ownerA,
      input: { project_id: project.id, session_id: session.id },
    });
    assert.equal(stored.status, 'paused');
    assert.equal(stored.latest_checkpoint_id, 'chk_root');
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
