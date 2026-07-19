import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  InMemoryProjectMemoryRepository,
  MCP_ERROR_CODES,
  PROJECT_MEMORY_SCHEMA_VERSION,
  ProjectMemoryService,
} from '../index.js';
import { validCheckpoint, validProject, validSession } from './fixtures.js';

const ownerA = 'issuer:https://id.example|subject:user-a';
const checkpointTimestamp = '2026-07-19T12:00:00.000Z';

function harness(startAt = checkpointTimestamp) {
  const repository = new InMemoryProjectMemoryRepository();
  const clock = { t: Date.parse(startAt) };
  let counter = 0;
  const service = new ProjectMemoryService({
    repository,
    now: () => new Date(clock.t).toISOString(),
    nextId: (prefix) => `${prefix}_${(counter += 1)}`,
    cursorSecret: 'test-cursor-secret',
  });
  return { repository, service, tick: (ms) => { clock.t += ms; } };
}

function saveInput({ projectId, sessionId, id = 'chk_root' }) {
  return {
    project_id: projectId,
    session_id: sessionId,
    checkpoint: validCheckpoint({ id, project_id: projectId, session_id: sessionId, created_at: checkpointTimestamp }),
    idempotency_key: 'save-root',
  };
}

async function seedCommitted(service) {
  const project = await service.createProject({ ownerScope: ownerA, input: { name: 'Bicycle Repair' } });
  const session = await service.createSession({ ownerScope: ownerA, input: { project_id: project.id, source_client: 'chatgpt' } });
  return { project, session };
}

// A repository double whose inspectProjectState returns exactly the crafted,
// unreachable-by-honest-writes state so the resume trust boundary is exercised.
function stubRepository(state) {
  return {
    async inspectProjectState() {
      if (!state) throw new Error('project-not-found');
      return structuredClone(state);
    },
  };
}

describe('resumeProject consistent freshness', () => {
  it('returns the committed head as fresh when activity does not exceed it', async () => {
    const { service } = harness();
    const { project, session } = await seedCommitted(service);
    await service.saveCheckpoint({ ownerScope: ownerA, input: saveInput({ projectId: project.id, sessionId: session.id }) });
    const resumed = await service.resumeProject({ ownerScope: ownerA, input: { project_id: project.id } });
    assert.equal(resumed.latest_checkpoint.id, 'chk_root');
    assert.equal(resumed.freshness, 'fresh');
    assert.deepEqual(resumed.warnings, []);
    assert.equal(resumed.content_trust, 'untrusted-persisted-data');
  });

  it('flags stale resume when session activity is newer than the checkpoint', async () => {
    const { service, tick } = harness();
    const { project, session } = await seedCommitted(service);
    tick(60_000);
    await service.saveCheckpoint({ ownerScope: ownerA, input: saveInput({ projectId: project.id, sessionId: session.id }) });
    const resumed = await service.resumeProject({ ownerScope: ownerA, input: { project_id: project.id } });
    assert.equal(resumed.freshness, 'stale');
    assert.deepEqual(resumed.warnings.map(({ code }) => code), ['checkpoint-predates-session']);
    assert.equal(resumed.warnings[0].schema_version, PROJECT_MEMORY_SCHEMA_VERSION);
  });

  it('returns incomplete with no durable checkpoint when none is committed', async () => {
    const { service } = harness();
    const project = await service.createProject({ ownerScope: ownerA, input: { name: 'Bicycle Repair' } });
    await service.createSession({ ownerScope: ownerA, input: { project_id: project.id, source_client: 'chatgpt' } });
    const resumed = await service.resumeProject({ ownerScope: ownerA, input: { project_id: project.id } });
    assert.equal(resumed.latest_checkpoint, null);
    assert.equal(resumed.freshness, 'incomplete');
    assert.deepEqual(resumed.warnings.map(({ code }) => code), ['no-durable-checkpoint']);
  });

  it('returns incomplete when the head session is interrupted', async () => {
    const { service } = harness();
    const { project, session } = await seedCommitted(service);
    await service.saveCheckpoint({ ownerScope: ownerA, input: saveInput({ projectId: project.id, sessionId: session.id }) });
    await service.transitionSession({ ownerScope: ownerA, input: { project_id: project.id, session_id: session.id, status: 'interrupted' } });
    const resumed = await service.resumeProject({ ownerScope: ownerA, input: { project_id: project.id } });
    assert.equal(resumed.freshness, 'incomplete');
    assert.ok(resumed.warnings.some(({ code }) => code === 'interrupted-session'));
  });

  it('rejects an unknown project with not-found', async () => {
    const { service } = harness();
    await assert.rejects(
      service.resumeProject({ ownerScope: ownerA, input: { project_id: 'prj_missing' } }),
      (error) => error.isError === true && error.error.code === MCP_ERROR_CODES.NOT_FOUND,
    );
  });
});

describe('resumeProject rejects inconsistent durable state as untrusted', () => {
  const genericWarning = { code: 'repository-state-inconsistent', message: 'The durable project state is incomplete and cannot be safely resumed.' };

  it('returns a generic incomplete resume for a mismatched committed head', async () => {
    const project = validProject({ latest_checkpoint_id: 'chk_missing' });
    const service = new ProjectMemoryService({ repository: stubRepository({ project, sessions: [], checkpoints: [] }) });
    const result = await service.resumeProject({ ownerScope: ownerA, input: { project_id: project.id } });
    assert.equal(result.project.id, project.id);
    assert.equal(result.latest_checkpoint, null);
    assert.equal(result.freshness, 'incomplete');
    assert.deepEqual(result.warnings, [genericWarning]);
    assert.equal(result.content_trust, 'untrusted-persisted-data');
  });

  it('rejects a session head that identifies no committed checkpoint', async () => {
    const project = validProject({ latest_checkpoint_id: null });
    const session = validSession({ latest_checkpoint_id: 'chk_ghost' });
    const service = new ProjectMemoryService({ repository: stubRepository({ project, sessions: [session], checkpoints: [] }) });
    const result = await service.resumeProject({ ownerScope: ownerA, input: { project_id: project.id } });
    assert.deepEqual(result.warnings, [genericWarning]);
    assert.equal(result.freshness, 'incomplete');
  });

  it('rejects a committed head that is not the highest revision', async () => {
    const checkpointOne = validCheckpoint({ id: 'chk_one', revision: 1, previous_checkpoint_id: null });
    const checkpointTwo = validCheckpoint({ id: 'chk_two', revision: 2, previous_checkpoint_id: 'chk_one' });
    const project = validProject({ latest_checkpoint_id: 'chk_one' });
    const service = new ProjectMemoryService({ repository: stubRepository({ project, sessions: [], checkpoints: [checkpointOne, checkpointTwo] }) });
    const result = await service.resumeProject({ ownerScope: ownerA, input: { project_id: project.id } });
    assert.deepEqual(result.warnings, [genericWarning]);
  });
});
