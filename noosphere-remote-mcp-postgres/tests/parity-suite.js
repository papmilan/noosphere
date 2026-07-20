import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';

import { validCheckpoint, validProject, validSession } from '../../noosphere-remote-mcp/tests/fixtures.js';

const ownerA = 'issuer:https://id.example|subject:user-a';
const ownerB = 'issuer:https://id.example|subject:user-b';
const later = '2026-07-19T13:00:00.000Z';

const idem = (key, requestHash) => ({ key, requestHash });
const projectedProject = (project, checkpoint, timestamp = later) => ({ ...project, updated_at: timestamp, last_activity_at: timestamp, latest_checkpoint_id: checkpoint.id });
const projectedSession = (session, checkpoint, timestamp = later) => ({ ...session, updated_at: timestamp, latest_checkpoint_id: checkpoint.id });

// Shared behavioural contract. Run against any ProjectMemoryRepository port
// implementation; passing proves observable parity with the in-memory reference.
// `createRepository` returns { repository, cleanup } with an empty owner space.
export function defineParitySuite({ label, createRepository }) {
  describe(`repository parity — ${label}`, () => {
    let repository;
    let cleanup;
    beforeEach(async () => { ({ repository, cleanup = async () => {} } = await createRepository()); });
    afterEach(async () => { await cleanup(); });

    it('rejects forged checkpoint heads on create without storing records', async () => {
      const project = validProject();
      const session = validSession();
      await assert.rejects(repository.createProject({ ownerScope: ownerA, project: { ...project, latest_checkpoint_id: 'chk_forged' } }), /project-checkpoint-head-mismatch/);
      assert.equal(await repository.getProject({ ownerScope: ownerA, projectId: project.id }), null);
      await repository.createProject({ ownerScope: ownerA, project });
      await assert.rejects(repository.createSession({ ownerScope: ownerA, session: { ...session, latest_checkpoint_id: 'chk_forged' } }), /session-checkpoint-head-mismatch/);
      assert.equal(await repository.getSession({ ownerScope: ownerA, projectId: project.id, sessionId: session.id }), null);
    });

    it('lists in insertion order and replaces only within the requested owner', async () => {
      const projectA = validProject();
      const projectB = validProject({ id: 'prj_second', name: 'Second', normalized_name: 'second' });
      await repository.createProject({ ownerScope: ownerA, project: projectA });
      await repository.createProject({ ownerScope: ownerA, project: projectB });
      await repository.createProject({ ownerScope: ownerB, project: projectA });

      assert.deepEqual((await repository.listProjects({ ownerScope: ownerA })).map(({ id }) => id), [projectA.id, projectB.id]);
      const replacement = { ...projectA, name: 'Projected Name', updated_at: later, last_activity_at: later };
      assert.deepEqual(await repository.replaceProject({ ownerScope: ownerA, projectId: projectA.id, project: replacement }), replacement);
      assert.deepEqual(await repository.getProject({ ownerScope: ownerA, projectId: projectA.id }), replacement);
      assert.deepEqual(await repository.getProject({ ownerScope: ownerB, projectId: projectA.id }), projectA);
      await assert.rejects(repository.replaceProject({ ownerScope: ownerA, projectId: projectA.id, project: { ...replacement, id: 'prj_wrong' } }), /project-id-mismatch/);
      await assert.rejects(repository.replaceProject({ ownerScope: ownerA, projectId: 'prj_missing', project: replacement }), (e) => e.name === 'RepositoryNotFoundError');
    });

    it('stores sessions under collision-safe owner/project/session tuples', async () => {
      const project = validProject();
      const session = validSession();
      await repository.createProject({ ownerScope: ownerA, project });
      await repository.createProject({ ownerScope: ownerB, project });
      await repository.createSession({ ownerScope: ownerA, session });
      await repository.createSession({ ownerScope: ownerB, session });
      assert.deepEqual(await repository.listSessions({ ownerScope: ownerA, projectId: project.id }), [session]);
      assert.equal(await repository.getSession({ ownerScope: ownerA, projectId: 'prj_missing', sessionId: session.id }), null);
      await assert.rejects(repository.createSession({ ownerScope: ownerA, session: validSession({ id: 'ses_x', project_id: 'prj_missing' }) }), (e) => e.name === 'RepositoryNotFoundError');
      await assert.rejects(repository.createSession({ ownerScope: ownerA, session }), (e) => e.code === 'session-conflict');
    });

    it('cascades an owner delete without touching another owner and rejects re-delete', async () => {
      const project = validProject();
      const session = validSession();
      const checkpoint = validCheckpoint();
      for (const owner of [ownerA, ownerB]) {
        await repository.createProject({ ownerScope: owner, project });
        await repository.createSession({ ownerScope: owner, session });
        await repository.saveCheckpoint({ ownerScope: owner, checkpoint, project: projectedProject(project, checkpoint), session: projectedSession(session, checkpoint), idempotency: idem(`save-${owner}`, `hash-${owner}`) });
      }
      await repository.deleteProject({ ownerScope: ownerA, projectId: project.id });
      assert.equal(await repository.getProject({ ownerScope: ownerA, projectId: project.id }), null);
      assert.equal(await repository.getSession({ ownerScope: ownerA, projectId: project.id, sessionId: session.id }), null);
      assert.equal(await repository.getCheckpoint({ ownerScope: ownerA, projectId: project.id, checkpointId: checkpoint.id }), null);
      assert.ok(await repository.getProject({ ownerScope: ownerB, projectId: project.id }));
      assert.ok(await repository.getCheckpoint({ ownerScope: ownerB, projectId: project.id, checkpointId: checkpoint.id }));
      // Deleted owner's receipt is gone (re-insert not deduplicated); other owner's remains.
      assert.equal((await repository.recordIdempotency({ ownerScope: ownerA, operation: 'save_checkpoint', key: `save-${ownerA}`, requestHash: 'replacement', result: {}, projectId: project.id })).deduplicated, false);
      await assert.rejects(repository.deleteProject({ ownerScope: ownerA, projectId: project.id }), (e) => e.name === 'RepositoryNotFoundError');
    });

    it('commits checkpoint + project head + session head + receipt atomically', async () => {
      const project = validProject();
      const session = validSession();
      const checkpoint = validCheckpoint();
      const nextProject = projectedProject(project, checkpoint);
      const nextSession = projectedSession(session, checkpoint);
      await repository.createProject({ ownerScope: ownerA, project });
      await repository.createSession({ ownerScope: ownerA, session });
      assert.deepEqual(await repository.saveCheckpoint({ ownerScope: ownerA, checkpoint, project: nextProject, session: nextSession, idempotency: idem('save-one', 'hash-one') }), { checkpoint, deduplicated: false });
      assert.deepEqual(await repository.getProject({ ownerScope: ownerA, projectId: project.id }), nextProject);
      assert.deepEqual(await repository.getSession({ ownerScope: ownerA, projectId: project.id, sessionId: session.id }), nextSession);
      assert.deepEqual(await repository.listCheckpoints({ ownerScope: ownerA, projectId: project.id }), [checkpoint]);
      assert.deepEqual(await repository.inspectProjectState({ ownerScope: ownerA, projectId: project.id }), { project: nextProject, sessions: [nextSession], checkpoints: [checkpoint] });
    });

    it('replays a matching committed save without applying newer projections', async () => {
      const project = validProject();
      const session = validSession();
      const checkpoint = validCheckpoint();
      const committedProject = projectedProject(project, checkpoint);
      const committedSession = projectedSession(session, checkpoint);
      await repository.createProject({ ownerScope: ownerA, project });
      await repository.createSession({ ownerScope: ownerA, session });
      await repository.saveCheckpoint({ ownerScope: ownerA, checkpoint, project: committedProject, session: committedSession, idempotency: idem('save-one', 'hash-one') });
      assert.deepEqual(await repository.saveCheckpoint({ ownerScope: ownerA, checkpoint, project: projectedProject(project, checkpoint, '2026-07-19T14:00:00.000Z'), session: projectedSession(session, checkpoint, '2026-07-19T14:00:00.000Z'), idempotency: idem('save-one', 'hash-one') }), { checkpoint, deduplicated: true });
      assert.deepEqual(await repository.getProject({ ownerScope: ownerA, projectId: project.id }), committedProject);
      await assert.rejects(repository.saveCheckpoint({ ownerScope: ownerA, checkpoint: validCheckpoint({ id: 'chk_x' }), project: projectedProject(project, validCheckpoint({ id: 'chk_x' })), session: projectedSession(session, validCheckpoint({ id: 'chk_x' })), idempotency: idem('save-one', 'different-hash') }), (e) => e.code === 'idempotency-conflict');
    });

    it('enforces a strictly linear checkpoint history', async () => {
      const project = validProject();
      const session = validSession();
      const root = validCheckpoint();
      await repository.createProject({ ownerScope: ownerA, project });
      await repository.createSession({ ownerScope: ownerA, session });
      await repository.saveCheckpoint({ ownerScope: ownerA, checkpoint: root, project: projectedProject(project, root), session: projectedSession(session, root), idempotency: idem('r', 'hr') });
      const secondRoot = validCheckpoint({ id: 'chk_second_root' });
      await assert.rejects(repository.saveCheckpoint({ ownerScope: ownerA, checkpoint: secondRoot, project: projectedProject(project, secondRoot), session: projectedSession(session, secondRoot), idempotency: idem('r2', 'hr2') }), (e) => e.code === 'checkpoint-predecessor-conflict');
      const revTwo = validCheckpoint({ id: 'chk_two', revision: 2, previous_checkpoint_id: root.id });
      assert.deepEqual(await repository.saveCheckpoint({ ownerScope: ownerA, checkpoint: revTwo, project: projectedProject(project, revTwo), session: projectedSession(session, revTwo), idempotency: idem('r3', 'hr3') }), { checkpoint: revTwo, deduplicated: false });
    });

    it('rejects a projected head that does not identify the committed checkpoint', async () => {
      const project = validProject();
      const session = validSession();
      const checkpoint = validCheckpoint();
      await repository.createProject({ ownerScope: ownerA, project });
      await repository.createSession({ ownerScope: ownerA, session });
      await assert.rejects(repository.saveCheckpoint({ ownerScope: ownerA, checkpoint, project: { ...project, latest_checkpoint_id: null }, session: projectedSession(session, checkpoint), idempotency: idem('bad', 'h') }), /project-checkpoint-head-mismatch/);
      // Failure left no checkpoint and no receipt.
      assert.deepEqual(await repository.listCheckpoints({ ownerScope: ownerA, projectId: project.id }), []);
      assert.deepEqual(await repository.saveCheckpoint({ ownerScope: ownerA, checkpoint, project: projectedProject(project, checkpoint), session: projectedSession(session, checkpoint), idempotency: idem('bad', 'different-hash') }), { checkpoint, deduplicated: false });
    });

    it('scopes idempotency receipts to (owner, operation, key) and cleans only the deleted project', async () => {
      const projectA = validProject();
      const projectB = validProject({ id: 'prj_second', name: 'Second', normalized_name: 'second' });
      await repository.createProject({ ownerScope: ownerA, project: projectA });
      await repository.createProject({ ownerScope: ownerA, project: projectB });
      await repository.recordIdempotency({ ownerScope: ownerA, operation: 'save_checkpoint', key: 'same', requestHash: 'a', result: { v: 'a' }, projectId: projectA.id });
      await repository.recordIdempotency({ ownerScope: ownerA, operation: 'save_checkpoint', key: 'other', requestHash: 'b', result: { v: 'b' }, projectId: projectB.id });
      await repository.recordIdempotency({ ownerScope: ownerA, operation: 'list_projects', key: 'unassoc', requestHash: 'd', result: { v: 'd' } });
      // Same key, different operation is a distinct receipt.
      assert.equal((await repository.recordIdempotency({ ownerScope: ownerA, operation: 'list_projects', key: 'same', requestHash: 'x', result: {} })).deduplicated, false);
      // Same key + different hash conflicts.
      await assert.rejects(repository.recordIdempotency({ ownerScope: ownerA, operation: 'save_checkpoint', key: 'same', requestHash: 'zzz', result: {} }), (e) => e.code === 'idempotency-conflict');

      await repository.deleteProject({ ownerScope: ownerA, projectId: projectA.id });
      assert.equal((await repository.recordIdempotency({ ownerScope: ownerA, operation: 'save_checkpoint', key: 'same', requestHash: 'replacement', result: {}, projectId: projectA.id })).deduplicated, false);
      assert.equal((await repository.recordIdempotency({ ownerScope: ownerA, operation: 'save_checkpoint', key: 'other', requestHash: 'b', result: {} })).deduplicated, true);
      assert.equal((await repository.recordIdempotency({ ownerScope: ownerA, operation: 'list_projects', key: 'unassoc', requestHash: 'd', result: {} })).deduplicated, true);
    });

    it('rejects an invalid owner scope', async () => {
      await assert.rejects(repository.listProjects({ ownerScope: 'ab' }), /invalid-owner-scope/);
    });
  });
}
