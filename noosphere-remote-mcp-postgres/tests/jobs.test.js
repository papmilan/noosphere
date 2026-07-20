import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { PostgresProjectMemoryRepository } from '../src/repository.js';
import { validCheckpoint, validProject, validSession } from '../../noosphere-remote-mcp/tests/fixtures.js';
import { dbHarness } from './db-helper.js';

const ownerA = 'issuer:https://id.example|subject:user-a';
const ownerB = 'issuer:https://id.example|subject:user-b';

const harness = dbHarness();
before(async () => { await harness.reset(); });
beforeEach(async () => { await harness.reset(); });
after(async () => { await harness.end(); });

const repo = (quota) => new PostgresProjectMemoryRepository({ pool: harness.pool, quota });

describe('quota', () => {
  it('rejects creating past projectsPerOwner and scopes the count per owner', async () => {
    const r = repo({ projectsPerOwner: 2 });
    await r.createProject({ ownerScope: ownerA, project: validProject({ id: 'prj_1', normalized_name: 'a' }) });
    await r.createProject({ ownerScope: ownerA, project: validProject({ id: 'prj_2', normalized_name: 'b' }) });
    await assert.rejects(r.createProject({ ownerScope: ownerA, project: validProject({ id: 'prj_3', normalized_name: 'c' }) }), (e) => e.code === 'project-quota-exceeded');
    // A different owner has its own budget.
    await r.createProject({ ownerScope: ownerB, project: validProject({ id: 'prj_1', normalized_name: 'a' }) });
  });

  it('applies no limit when unconfigured', async () => {
    const r = repo();
    for (let i = 0; i < 5; i += 1) await r.createProject({ ownerScope: ownerA, project: validProject({ id: `prj_${i}`, normalized_name: `n${i}` }) });
    assert.equal((await r.listProjects({ ownerScope: ownerA })).length, 5);
  });
});

describe('export / retention / purge jobs', () => {
  it('exports an owner-scoped project snapshot', async () => {
    const r = repo();
    const project = validProject();
    const session = validSession();
    const checkpoint = validCheckpoint();
    await r.createProject({ ownerScope: ownerA, project });
    await r.createSession({ ownerScope: ownerA, session });
    await r.saveCheckpoint({ ownerScope: ownerA, checkpoint, project: { ...project, updated_at: project.updated_at, last_activity_at: project.last_activity_at, latest_checkpoint_id: checkpoint.id }, session: { ...session, latest_checkpoint_id: checkpoint.id }, idempotency: { key: 'k', requestHash: 'h' } });
    const snap = await r.exportProject({ ownerScope: ownerA, projectId: project.id });
    assert.equal(snap.project.id, project.id);
    assert.equal(snap.checkpoints.length, 1);
    assert.equal(snap.sessions.length, 1);
  });

  it('marks, lists, and purges expired projects; future markers survive', async () => {
    const r = repo();
    await r.createProject({ ownerScope: ownerA, project: validProject({ id: 'prj_old', normalized_name: 'old' }) });
    await r.createProject({ ownerScope: ownerA, project: validProject({ id: 'prj_keep', normalized_name: 'keep' }) });
    await r.setRetentionMarker({ ownerScope: ownerA, projectId: 'prj_old', retainUntil: '2026-01-01T00:00:00.000Z', reason: 'expired' });
    await r.setRetentionMarker({ ownerScope: ownerA, projectId: 'prj_keep', retainUntil: '2999-01-01T00:00:00.000Z' });

    const now = '2026-07-20T00:00:00.000Z';
    assert.deepEqual(await r.listExpiredProjects({ ownerScope: ownerA, now }), ['prj_old']);
    assert.deepEqual(await r.purgeExpiredProjects({ ownerScope: ownerA, now }), ['prj_old']);
    assert.equal(await r.getProject({ ownerScope: ownerA, projectId: 'prj_old' }), null);
    assert.ok(await r.getProject({ ownerScope: ownerA, projectId: 'prj_keep' }));
    assert.deepEqual(await r.listExpiredProjects({ ownerScope: ownerA, now }), []);
  });

  it('rejects a retention marker for a missing project', async () => {
    const r = repo();
    await assert.rejects(r.setRetentionMarker({ ownerScope: ownerA, projectId: 'prj_missing', retainUntil: '2999-01-01T00:00:00.000Z' }), (e) => e.name === 'RepositoryNotFoundError');
  });
});
