import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  InMemoryProjectMemoryRepository,
  MCP_TOOLS,
  MCP_ERROR_CODES,
  PROJECT_MEMORY_SCHEMA_VERSION,
  ProjectMemoryService,
} from '../index.js';
import { validCheckpoint, validProject, validSession } from './fixtures.js';

// Structural check against the published resume_project warning item schema so
// every warning the service emits is proven to satisfy the contract clients
// consume — without pulling in a JSON-schema runtime dependency.
const WARNING_SCHEMA = MCP_TOOLS.resume_project.output.properties.warnings.items;

function assertValidWarning(warning) {
  const { required, properties } = WARNING_SCHEMA;
  assert.deepEqual(Object.keys(warning).sort(), [...required].sort(), 'warning keys must match schema');
  assert.equal(warning.schema_version, properties.schema_version.const);
  assert.ok(properties.code.enum.includes(warning.code), `code ${warning.code} in enum`);
  assert.equal(typeof warning.message, 'string');
  assert.ok(warning.message.length >= 1 && warning.message.length <= properties.message.maxLength);
}

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
    await service.saveCheckpoint({ ownerScope: ownerA, input: saveInput({ projectId: project.id, sessionId: session.id }) });
    tick(60_000);
    await service.transitionSession({
      ownerScope: ownerA,
      input: { project_id: project.id, session_id: session.id, status: 'paused' },
    });
    const resumed = await service.resumeProject({ ownerScope: ownerA, input: { project_id: project.id } });
    assert.equal(resumed.freshness, 'stale');
    assert.deepEqual(resumed.warnings.map(({ code }) => code), ['checkpoint-predates-session']);
    resumed.warnings.forEach(assertValidWarning);
  });

  it('treats an immediately committed checkpoint as fresh despite upload delay', async () => {
    const { service } = harness('2026-07-19T12:00:01.000Z');
    const { project, session } = await seedCommitted(service);

    const saved = await service.saveCheckpoint({
      ownerScope: ownerA,
      input: saveInput({ projectId: project.id, sessionId: session.id }),
    });
    const resumed = await service.resumeProject({ ownerScope: ownerA, input: { project_id: project.id } });

    assert.equal(saved.checkpoint.created_at, '2026-07-19T12:00:01.000Z');
    assert.equal(resumed.freshness, 'fresh');
    assert.deepEqual(resumed.warnings, []);
  });

  it('replaces a client-supplied future checkpoint timestamp with server commit time', async () => {
    const { service } = harness('2026-07-19T12:00:01.000Z');
    const { project, session } = await seedCommitted(service);
    const input = saveInput({ projectId: project.id, sessionId: session.id });
    input.checkpoint.created_at = '9999-12-31T23:59:59.999Z';

    const saved = await service.saveCheckpoint({ ownerScope: ownerA, input });

    assert.equal(saved.checkpoint.created_at, '2026-07-19T12:00:01.000Z');
  });

  it('classifies the latest interrupted session as incomplete even when another session owns the head', async () => {
    const { service, tick } = harness();
    const { project, session } = await seedCommitted(service);
    await service.saveCheckpoint({ ownerScope: ownerA, input: saveInput({ projectId: project.id, sessionId: session.id }) });
    tick(1_000);
    const later = await service.createSession({
      ownerScope: ownerA,
      input: { project_id: project.id, source_client: 'claude' },
    });
    tick(1_000);
    await service.transitionSession({
      ownerScope: ownerA,
      input: { project_id: project.id, session_id: later.id, status: 'interrupted' },
    });

    const resumed = await service.resumeProject({ ownerScope: ownerA, input: { project_id: project.id } });

    assert.equal(resumed.freshness, 'incomplete');
    assert.equal(resumed.warnings.some(({ code }) => code === 'interrupted-session'), true);
  });

  it('returns incomplete with no durable checkpoint when none is committed', async () => {
    const { service } = harness();
    const project = await service.createProject({ ownerScope: ownerA, input: { name: 'Bicycle Repair' } });
    await service.createSession({ ownerScope: ownerA, input: { project_id: project.id, source_client: 'chatgpt' } });
    const resumed = await service.resumeProject({ ownerScope: ownerA, input: { project_id: project.id } });
    assert.equal(resumed.latest_checkpoint, null);
    assert.equal(resumed.freshness, 'incomplete');
    assert.deepEqual(resumed.warnings.map(({ code }) => code), ['no-durable-checkpoint']);
    resumed.warnings.forEach(assertValidWarning);
  });

  it('returns incomplete when the head session is interrupted', async () => {
    const { service } = harness();
    const { project, session } = await seedCommitted(service);
    await service.saveCheckpoint({ ownerScope: ownerA, input: saveInput({ projectId: project.id, sessionId: session.id }) });
    await service.transitionSession({ ownerScope: ownerA, input: { project_id: project.id, session_id: session.id, status: 'interrupted' } });
    const resumed = await service.resumeProject({ ownerScope: ownerA, input: { project_id: project.id } });
    assert.equal(resumed.freshness, 'incomplete');
    assert.ok(resumed.warnings.some(({ code }) => code === 'interrupted-session'));
    resumed.warnings.forEach(assertValidWarning);
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
  const genericWarning = {
    schema_version: PROJECT_MEMORY_SCHEMA_VERSION,
    code: 'repository-state-inconsistent',
    message: 'The durable project state is incomplete and cannot be safely resumed.',
  };

  it('returns a generic incomplete resume for a mismatched committed head', async () => {
    const project = validProject({ latest_checkpoint_id: 'chk_missing' });
    const service = new ProjectMemoryService({ repository: stubRepository({ project, sessions: [], checkpoints: [] }) });
    const result = await service.resumeProject({ ownerScope: ownerA, input: { project_id: project.id } });
    assert.equal(result.project.id, project.id);
    assert.equal(result.latest_checkpoint, null);
    assert.equal(result.freshness, 'incomplete');
    assert.deepEqual(result.warnings, [genericWarning]);
    assertValidWarning(result.warnings[0]);
    assert.equal(result.content_trust, 'untrusted-persisted-data');
  });

  it('rejects a session head that identifies no committed checkpoint', async () => {
    const project = validProject({ latest_checkpoint_id: null });
    const session = validSession({ latest_checkpoint_id: 'chk_ghost' });
    const service = new ProjectMemoryService({ repository: stubRepository({ project, sessions: [session], checkpoints: [] }) });
    const result = await service.resumeProject({ ownerScope: ownerA, input: { project_id: project.id } });
    assert.deepEqual(result.warnings, [genericWarning]);
    result.warnings.forEach(assertValidWarning);
    assert.equal(result.freshness, 'incomplete');
  });

  it('rejects a committed head that is not the highest revision', async () => {
    const checkpointOne = validCheckpoint({ id: 'chk_one', revision: 1, previous_checkpoint_id: null });
    const checkpointTwo = validCheckpoint({ id: 'chk_two', revision: 2, previous_checkpoint_id: 'chk_one' });
    const project = validProject({ latest_checkpoint_id: 'chk_one' });
    const service = new ProjectMemoryService({ repository: stubRepository({ project, sessions: [], checkpoints: [checkpointOne, checkpointTwo] }) });
    const result = await service.resumeProject({ ownerScope: ownerA, input: { project_id: project.id } });
    assert.deepEqual(result.warnings, [genericWarning]);
    result.warnings.forEach(assertValidWarning);
  });

  it('rejects a highest-revision head whose predecessor chain is incomplete', async () => {
    const checkpointOne = validCheckpoint({
      id: 'chk_one', revision: 1, previous_checkpoint_id: null, session_id: null,
    });
    const checkpointThree = validCheckpoint({
      id: 'chk_three', revision: 3, previous_checkpoint_id: 'chk_missing', session_id: null,
    });
    const project = validProject({ latest_checkpoint_id: 'chk_three' });
    const service = new ProjectMemoryService({
      repository: stubRepository({ project, sessions: [], checkpoints: [checkpointOne, checkpointThree] }),
    });

    const result = await service.resumeProject({ ownerScope: ownerA, input: { project_id: project.id } });

    assert.deepEqual(result.warnings, [genericWarning]);
    assert.equal(result.latest_checkpoint, null);
  });

  it('rejects forked checkpoint history even when the selected head has the maximum revision', async () => {
    const checkpointOne = validCheckpoint({
      id: 'chk_one', revision: 1, previous_checkpoint_id: null, session_id: null,
    });
    const checkpointTwoA = validCheckpoint({
      id: 'chk_two_a', revision: 2, previous_checkpoint_id: 'chk_one', session_id: null,
    });
    const checkpointTwoB = validCheckpoint({
      id: 'chk_two_b', revision: 2, previous_checkpoint_id: 'chk_one', session_id: null,
    });
    const project = validProject({ latest_checkpoint_id: 'chk_two_b' });
    const service = new ProjectMemoryService({
      repository: stubRepository({
        project,
        sessions: [],
        checkpoints: [checkpointOne, checkpointTwoA, checkpointTwoB],
      }),
    });

    const result = await service.resumeProject({ ownerScope: ownerA, input: { project_id: project.id } });

    assert.deepEqual(result.warnings, [genericWarning]);
    assert.equal(result.latest_checkpoint, null);
  });

  it('rejects a session head that points at a checkpoint owned by no session', async () => {
    const checkpoint = validCheckpoint({
      id: 'chk_one', revision: 1, previous_checkpoint_id: null, session_id: null,
    });
    const project = validProject({ latest_checkpoint_id: checkpoint.id });
    const session = validSession({ latest_checkpoint_id: checkpoint.id });
    const service = new ProjectMemoryService({
      repository: stubRepository({ project, sessions: [session], checkpoints: [checkpoint] }),
    });

    const result = await service.resumeProject({ ownerScope: ownerA, input: { project_id: project.id } });

    assert.deepEqual(result.warnings, [genericWarning]);
    assert.equal(result.latest_checkpoint, null);
  });
});
