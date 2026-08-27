import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemoryProjectMemoryRepository, POSTGRESQL_REPOSITORY_CONTRACT, ProjectMemoryRepository } from '../index.js';
import { validCheckpoint, validProject, validSession } from './fixtures.js';

const ownerA = 'issuer:https://id.example|subject:user-a';
const ownerB = 'issuer:https://id.example|subject:user-b';
const later = '2026-07-19T13:00:00.000Z';
const latest = '2026-07-19T14:00:00.000Z';

function idempotency(key, requestHash) {
  return { key, requestHash };
}

function projectedProject(project, checkpoint, timestamp = later) {
  return {
    ...project,
    updated_at: timestamp,
    last_activity_at: timestamp,
    latest_checkpoint_id: checkpoint.id,
  };
}

function projectedSession(session, checkpoint, timestamp = later) {
  return {
    ...session,
    updated_at: timestamp,
    latest_checkpoint_id: checkpoint.id,
  };
}

describe('Project Memory repository port', () => {
  it('implements every required persistence operation on the concrete repository', () => {
    const repository = new InMemoryProjectMemoryRepository();
    for (const method of POSTGRESQL_REPOSITORY_CONTRACT.requiredMethods) {
      assert.equal(typeof repository[method], 'function', method);
      // Guard against false confidence: the method must be concretely
      // overridden, not the abstract not-implemented stub.
      assert.notEqual(
        InMemoryProjectMemoryRepository.prototype[method],
        ProjectMemoryRepository.prototype[method],
        `${method} must be implemented by InMemoryProjectMemoryRepository`,
      );
    }
  });

  it('declares no abstract port method the concrete repository leaves unimplemented', () => {
    for (const method of Object.getOwnPropertyNames(ProjectMemoryRepository.prototype)) {
      if (method === 'constructor') continue;
      assert.notEqual(
        InMemoryProjectMemoryRepository.prototype[method],
        ProjectMemoryRepository.prototype[method],
        `abstract port declares ${method} but the concrete repository does not implement it`,
      );
    }
  });
});

describe('owner-scoped Project Memory repository operations', () => {
  it('rejects forged checkpoint heads on Project and Session creation without storing records', async () => {
    const repository = new InMemoryProjectMemoryRepository();
    const project = validProject();
    const session = validSession();

    await assert.rejects(
      repository.createProject({ ownerScope: ownerA, project: { ...project, latest_checkpoint_id: 'chk_forged' } }),
      /project-checkpoint-head-mismatch/,
    );
    assert.equal(await repository.getProject({ ownerScope: ownerA, projectId: project.id }), null);

    await repository.createProject({ ownerScope: ownerA, project });
    await assert.rejects(
      repository.createSession({ ownerScope: ownerA, session: { ...session, latest_checkpoint_id: 'chk_forged' } }),
      /session-checkpoint-head-mismatch/,
    );
    assert.equal(await repository.getSession({ ownerScope: ownerA, projectId: project.id, sessionId: session.id }), null);
  });

  it('lists and replaces only projected Projects under the requested owner', async () => {
    const repository = new InMemoryProjectMemoryRepository();
    const projectA = validProject();
    const projectB = validProject({ id: 'prj_second', name: 'Second', normalized_name: 'second' });
    await repository.createProject({ ownerScope: ownerA, project: projectA });
    await repository.createProject({ ownerScope: ownerA, project: projectB });
    await repository.createProject({ ownerScope: ownerB, project: projectA });

    const listed = await repository.listProjects({ ownerScope: ownerA });
    assert.deepEqual(listed.map(({ id }) => id), [projectA.id, projectB.id]);
    listed[0].name = 'mutated outside repository';
    assert.equal((await repository.getProject({ ownerScope: ownerA, projectId: projectA.id })).name, projectA.name);

    const replacement = { ...projectA, name: 'Projected Name', updated_at: later, last_activity_at: later };
    assert.deepEqual(await repository.replaceProject({ ownerScope: ownerA, projectId: projectA.id, project: replacement }), replacement);
    assert.deepEqual(await repository.getProject({ ownerScope: ownerA, projectId: projectA.id }), replacement);
    assert.deepEqual(await repository.getProject({ ownerScope: ownerB, projectId: projectA.id }), projectA);
    await assert.rejects(
      repository.replaceProject({ ownerScope: ownerA, projectId: projectA.id, project: { ...replacement, id: 'prj_wrong' } }),
      /project-id-mismatch/,
    );
  });

  it('stores Sessions under collision-safe owner, Project, and Session tuples', async () => {
    const repository = new InMemoryProjectMemoryRepository();
    const project = validProject();
    const session = validSession();
    await repository.createProject({ ownerScope: ownerA, project });
    await repository.createProject({ ownerScope: ownerB, project });
    await repository.createSession({ ownerScope: ownerA, session });
    await repository.createSession({ ownerScope: ownerB, session });

    assert.deepEqual(await repository.listSessions({ ownerScope: ownerA, projectId: project.id }), [session]);
    assert.deepEqual(await repository.getSession({ ownerScope: ownerA, projectId: project.id, sessionId: session.id }), session);
    assert.equal(await repository.getSession({ ownerScope: ownerA, projectId: 'prj_missing', sessionId: session.id }), null);

    const replacement = { ...session, status: 'paused', updated_at: later };
    assert.deepEqual(await repository.replaceSession({ ownerScope: ownerA, projectId: project.id, sessionId: session.id, session: replacement }), replacement);
    assert.deepEqual(await repository.getSession({ ownerScope: ownerB, projectId: project.id, sessionId: session.id }), session);
    await assert.rejects(
      repository.createSession({ ownerScope: ownerA, session: validSession({ id: 'ses_missing', project_id: 'prj_missing' }) }),
      /project-not-found/,
    );
    await assert.rejects(
      repository.createSession({ ownerScope: ownerA, session }),
      (error) => error.code === 'session-conflict',
    );
  });

  it('cascades an owner delete without affecting the same ID under another owner', async () => {
    const repository = new InMemoryProjectMemoryRepository();
    const project = validProject();
    const session = validSession();
    const checkpoint = validCheckpoint();
    await repository.createProject({ ownerScope: ownerA, project });
    await repository.createProject({ ownerScope: ownerB, project });
    await repository.createSession({ ownerScope: ownerA, session });
    await repository.createSession({ ownerScope: ownerB, session });
    await repository.saveCheckpoint({
      ownerScope: ownerA,
      checkpoint,
      project: projectedProject(project, checkpoint),
      session: projectedSession(session, checkpoint),
      idempotency: idempotency('owner-a-save', 'hash-owner-a'),
    });
    await repository.saveCheckpoint({
      ownerScope: ownerB,
      checkpoint,
      project: projectedProject(project, checkpoint),
      session: projectedSession(session, checkpoint),
      idempotency: idempotency('owner-b-save', 'hash-owner-b'),
    });

    await repository.deleteProject({ ownerScope: ownerA, projectId: project.id });

    assert.equal(await repository.getProject({ ownerScope: ownerA, projectId: project.id }), null);
    assert.equal(await repository.getSession({ ownerScope: ownerA, projectId: project.id, sessionId: session.id }), null);
    assert.equal(await repository.getCheckpoint({ ownerScope: ownerA, projectId: project.id, checkpointId: checkpoint.id }), null);
    assert.ok(await repository.getProject({ ownerScope: ownerB, projectId: project.id }));
    assert.ok(await repository.getSession({ ownerScope: ownerB, projectId: project.id, sessionId: session.id }));
    assert.ok(await repository.getCheckpoint({ ownerScope: ownerB, projectId: project.id, checkpointId: checkpoint.id }));
    assert.equal((await repository.recordIdempotency({
      ownerScope: ownerA,
      operation: 'save_checkpoint',
      key: 'owner-a-save',
      requestHash: 'replacement-after-delete',
      result: {},
      projectId: project.id,
    })).deduplicated, false);
    await assert.rejects(repository.deleteProject({ ownerScope: ownerA, projectId: project.id }), /project-not-found/);
  });
});

describe('atomic projected checkpoint persistence', () => {
  it('preserves committed heads across replacement and cannot commit a second revision-one root', async () => {
    const repository = new InMemoryProjectMemoryRepository();
    const project = validProject();
    const session = validSession();
    const checkpoint = validCheckpoint();
    const committedProject = projectedProject(project, checkpoint);
    const committedSession = projectedSession(session, checkpoint);
    await repository.createProject({ ownerScope: ownerA, project });
    await repository.createSession({ ownerScope: ownerA, session });
    await repository.saveCheckpoint({
      ownerScope: ownerA,
      checkpoint,
      project: committedProject,
      session: committedSession,
      idempotency: idempotency('save-root', 'hash-root'),
    });

    for (const forgedHead of [null, 'chk_forged']) {
      await assert.rejects(
        repository.replaceProject({
          ownerScope: ownerA,
          projectId: project.id,
          project: { ...committedProject, name: 'Rejected Project Rewrite', latest_checkpoint_id: forgedHead },
        }),
        /project-checkpoint-head-mismatch/,
      );
      await assert.rejects(
        repository.replaceSession({
          ownerScope: ownerA,
          projectId: project.id,
          sessionId: session.id,
          session: { ...committedSession, status: 'paused', latest_checkpoint_id: forgedHead },
        }),
        /session-checkpoint-head-mismatch/,
      );
    }
    assert.deepEqual(await repository.getProject({ ownerScope: ownerA, projectId: project.id }), committedProject);
    assert.deepEqual(await repository.getSession({ ownerScope: ownerA, projectId: project.id, sessionId: session.id }), committedSession);

    const secondRoot = validCheckpoint({ id: 'chk_second_root' });
    await assert.rejects(
      repository.saveCheckpoint({
        ownerScope: ownerA,
        checkpoint: secondRoot,
        project: projectedProject(committedProject, secondRoot),
        session: projectedSession(committedSession, secondRoot),
        idempotency: idempotency('save-after-rejected-rewrite', 'hash-second-root'),
      }),
      (error) => error.code === 'checkpoint-predecessor-conflict',
    );
    assert.equal(await repository.getCheckpoint({ ownerScope: ownerA, projectId: project.id, checkpointId: secondRoot.id }), null);

    const revisionTwo = validCheckpoint({
      id: 'chk_revision_two',
      revision: 2,
      previous_checkpoint_id: checkpoint.id,
    });
    assert.deepEqual(await repository.saveCheckpoint({
      ownerScope: ownerA,
      checkpoint: revisionTwo,
      project: projectedProject(committedProject, revisionTwo),
      session: projectedSession(committedSession, revisionTwo),
      idempotency: idempotency('save-after-rejected-rewrite', 'different-hash-after-failure'),
    }), { checkpoint: revisionTwo, deduplicated: false });
  });

  it('commits checkpoint, Project head, Session head, and receipt together', async () => {
    const repository = new InMemoryProjectMemoryRepository();
    const project = validProject();
    const session = validSession();
    const checkpoint = validCheckpoint();
    const nextProject = projectedProject(project, checkpoint);
    const nextSession = projectedSession(session, checkpoint);
    await repository.createProject({ ownerScope: ownerA, project });
    await repository.createSession({ ownerScope: ownerA, session });

    assert.deepEqual(await repository.saveCheckpoint({
      ownerScope: ownerA,
      checkpoint,
      project: nextProject,
      session: nextSession,
      idempotency: idempotency('save-one', 'hash-one'),
    }), { checkpoint, deduplicated: false });

    assert.deepEqual(await repository.getProject({ ownerScope: ownerA, projectId: project.id }), nextProject);
    assert.deepEqual(await repository.getSession({ ownerScope: ownerA, projectId: project.id, sessionId: session.id }), nextSession);
    assert.deepEqual(await repository.getCheckpoint({ ownerScope: ownerA, projectId: project.id, checkpointId: checkpoint.id }), checkpoint);
    assert.deepEqual(await repository.listCheckpoints({ ownerScope: ownerA, projectId: project.id }), [checkpoint]);
    assert.deepEqual(await repository.inspectProjectState({ ownerScope: ownerA, projectId: project.id }), {
      project: nextProject,
      sessions: [nextSession],
      checkpoints: [checkpoint],
    });
  });

  it('replays a matching committed save without applying newer projections', async () => {
    const repository = new InMemoryProjectMemoryRepository();
    const project = validProject();
    const session = validSession();
    const checkpoint = validCheckpoint();
    const committedProject = projectedProject(project, checkpoint);
    const committedSession = projectedSession(session, checkpoint);
    await repository.createProject({ ownerScope: ownerA, project });
    await repository.createSession({ ownerScope: ownerA, session });
    await repository.saveCheckpoint({
      ownerScope: ownerA,
      checkpoint,
      project: committedProject,
      session: committedSession,
      idempotency: idempotency('save-one', 'hash-one'),
    });

    assert.deepEqual(await repository.saveCheckpoint({
      ownerScope: ownerA,
      checkpoint,
      project: projectedProject(project, checkpoint, latest),
      session: projectedSession(session, checkpoint, latest),
      idempotency: idempotency('save-one', 'hash-one'),
    }), { checkpoint, deduplicated: true });
    assert.deepEqual(await repository.getProject({ ownerScope: ownerA, projectId: project.id }), committedProject);
    assert.deepEqual(await repository.getSession({ ownerScope: ownerA, projectId: project.id, sessionId: session.id }), committedSession);
  });

  it('validates every projection before mutation and creates no receipt on failure', async () => {
    const repository = new InMemoryProjectMemoryRepository();
    const project = validProject();
    const session = validSession();
    const checkpoint = validCheckpoint();
    await repository.createProject({ ownerScope: ownerA, project });
    await repository.createSession({ ownerScope: ownerA, session });

    await assert.rejects(
      repository.saveCheckpoint({
        ownerScope: ownerA,
        checkpoint,
        project: projectedProject(project, checkpoint),
        session: { ...projectedSession(session, checkpoint), unknown: true },
        idempotency: idempotency('save-one', 'hash-one'),
      }),
      /unknown-field:unknown/,
    );
    assert.deepEqual(await repository.inspectProjectState({ ownerScope: ownerA, projectId: project.id }), {
      project,
      sessions: [session],
      checkpoints: [],
    });

    assert.deepEqual(await repository.saveCheckpoint({
      ownerScope: ownerA,
      checkpoint,
      project: projectedProject(project, checkpoint),
      session: projectedSession(session, checkpoint),
      idempotency: idempotency('save-one', 'different-hash-after-failure'),
    }), { checkpoint, deduplicated: false });
  });

  it('rejects projected heads that do not identify the committed checkpoint', async () => {
    const repository = new InMemoryProjectMemoryRepository();
    const project = validProject();
    const session = validSession();
    const checkpoint = validCheckpoint();
    await repository.createProject({ ownerScope: ownerA, project });
    await repository.createSession({ ownerScope: ownerA, session });

    await assert.rejects(
      repository.saveCheckpoint({
        ownerScope: ownerA,
        checkpoint,
        project: { ...project, latest_checkpoint_id: null },
        session: projectedSession(session, checkpoint),
        idempotency: idempotency('bad-project-head', 'hash-project'),
      }),
      /project-checkpoint-head-mismatch/,
    );
    await assert.rejects(
      repository.saveCheckpoint({
        ownerScope: ownerA,
        checkpoint,
        project: projectedProject(project, checkpoint),
        session: { ...session, latest_checkpoint_id: null },
        idempotency: idempotency('bad-session-head', 'hash-session'),
      }),
      /session-checkpoint-head-mismatch/,
    );
  });
});

describe('project-associated idempotency receipts', () => {
  it('removes only receipts associated with the deleted owner Project', async () => {
    const repository = new InMemoryProjectMemoryRepository();
    const projectA = validProject();
    const projectB = validProject({ id: 'prj_second', name: 'Second', normalized_name: 'second' });
    await repository.createProject({ ownerScope: ownerA, project: projectA });
    await repository.createProject({ ownerScope: ownerA, project: projectB });
    await repository.createProject({ ownerScope: ownerB, project: projectA });
    await repository.recordIdempotency({ ownerScope: ownerA, operation: 'save_checkpoint', key: 'same', requestHash: 'a', result: { accepted: 'a' }, projectId: projectA.id });
    await repository.recordIdempotency({ ownerScope: ownerA, operation: 'save_checkpoint', key: 'other', requestHash: 'b', result: { accepted: 'b' }, projectId: projectB.id });
    await repository.recordIdempotency({ ownerScope: ownerA, operation: 'list_projects', key: 'unassociated', requestHash: 'd', result: { accepted: 'd' } });
    await repository.recordIdempotency({ ownerScope: ownerB, operation: 'save_checkpoint', key: 'same', requestHash: 'c', result: { accepted: 'c' }, projectId: projectA.id });

    await repository.deleteProject({ ownerScope: ownerA, projectId: projectA.id });

    assert.equal((await repository.recordIdempotency({ ownerScope: ownerA, operation: 'save_checkpoint', key: 'same', requestHash: 'replacement', result: {}, projectId: projectA.id })).deduplicated, false);
    assert.equal((await repository.recordIdempotency({ ownerScope: ownerA, operation: 'save_checkpoint', key: 'other', requestHash: 'b', result: {} })).deduplicated, true);
    assert.equal((await repository.recordIdempotency({ ownerScope: ownerA, operation: 'list_projects', key: 'unassociated', requestHash: 'd', result: {} })).deduplicated, true);
    assert.equal((await repository.recordIdempotency({ ownerScope: ownerB, operation: 'save_checkpoint', key: 'same', requestHash: 'c', result: {} })).deduplicated, true);
  });

  it('does not add project association to the idempotency lookup tuple', async () => {
    const repository = new InMemoryProjectMemoryRepository();
    assert.equal((await repository.recordIdempotency({
      ownerScope: ownerA,
      operation: 'save_checkpoint',
      key: 'shared',
      requestHash: 'same-hash',
      result: { accepted: true },
      projectId: 'prj_first',
    })).deduplicated, false);
    assert.equal((await repository.recordIdempotency({
      ownerScope: ownerA,
      operation: 'save_checkpoint',
      key: 'shared',
      requestHash: 'same-hash',
      result: { accepted: false },
      projectId: 'prj_second',
    })).deduplicated, true);
    await assert.rejects(
      repository.recordIdempotency({
        ownerScope: ownerA,
        operation: 'save_checkpoint',
        key: 'shared',
        requestHash: 'different-hash',
        result: {},
        projectId: 'prj_second',
      }),
      (error) => error.code === 'idempotency-conflict',
    );
  });
});

describe('repository snapshot restore boundary', () => {
  async function committedRepository() {
    const repository = new InMemoryProjectMemoryRepository();
    const project = validProject();
    const session = validSession();
    const checkpoint = validCheckpoint();
    await repository.createProject({ ownerScope: ownerA, project });
    await repository.createSession({ ownerScope: ownerA, session });
    await repository.saveCheckpoint({
      ownerScope: ownerA,
      checkpoint,
      project: projectedProject(project, checkpoint),
      session: projectedSession(session, checkpoint),
      idempotency: idempotency('snapshot-save', 'snapshot-hash'),
    });
    return { repository, project, session, checkpoint };
  }

  it('round-trips a complete committed snapshot into a fresh repository', async () => {
    const { repository, project, session, checkpoint } = await committedRepository();
    const restored = new InMemoryProjectMemoryRepository();
    restored.restore(repository.snapshot());

    assert.equal((await restored.getProject({ ownerScope: ownerA, projectId: project.id })).latest_checkpoint_id, checkpoint.id);
    assert.equal((await restored.getSession({ ownerScope: ownerA, projectId: project.id, sessionId: session.id })).latest_checkpoint_id, checkpoint.id);
    assert.equal((await restored.getCheckpoint({ ownerScope: ownerA, projectId: project.id, checkpointId: checkpoint.id })).revision, 1);
  });

  it('rejects valid records stored under substituted tuple keys without changing live state', async () => {
    const { repository, project } = await committedRepository();
    const corrupt = repository.snapshot();
    corrupt.projects[ownerA].prj_substitute = corrupt.projects[ownerA][project.id];
    delete corrupt.projects[ownerA][project.id];

    assert.throws(() => repository.restore(corrupt), /invalid-snapshot/);
    assert.equal((await repository.getProject({ ownerScope: ownerA, projectId: project.id })).id, project.id);
  });

  it('rejects individually valid records whose durable checkpoint heads disagree', async () => {
    const { repository, project } = await committedRepository();
    const corrupt = repository.snapshot();
    corrupt.projects[ownerA][project.id].latest_checkpoint_id = null;

    assert.throws(() => repository.restore(corrupt), /invalid-snapshot/);
    assert.throws(() => repository.restore({ ...repository.snapshot(), unexpected: {} }), /invalid-snapshot/);
  });
});
