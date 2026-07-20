import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import pg from 'pg';

import { PostgresProjectMemoryRepository } from '../src/repository.js';
import { validCheckpoint, validProject, validSession } from '../../noosphere-remote-mcp/tests/fixtures.js';
import { dbHarness } from './db-helper.js';

const ownerA = 'issuer:https://id.example|subject:user-a';
const ownerB = 'issuer:https://id.example|subject:user-b';
const later = '2026-07-19T13:00:00.000Z';

const harness = dbHarness();
before(async () => { await harness.reset(); });
beforeEach(async () => { await harness.reset(); });
after(async () => { await harness.end(); });

const proj = (p, c) => ({ ...p, updated_at: later, last_activity_at: later, latest_checkpoint_id: c.id });
const sess = (s, c) => ({ ...s, updated_at: later, latest_checkpoint_id: c.id });

describe('concurrency', () => {
  it('lets exactly one of two concurrent revision-1 checkpoint writers win', async () => {
    const repo = new PostgresProjectMemoryRepository({ pool: harness.pool });
    const project = validProject();
    const session = validSession();
    await repo.createProject({ ownerScope: ownerA, project });
    await repo.createSession({ ownerScope: ownerA, session });
    const a = validCheckpoint({ id: 'chk_a' });
    const b = validCheckpoint({ id: 'chk_b' });
    const results = await Promise.allSettled([
      repo.saveCheckpoint({ ownerScope: ownerA, checkpoint: a, project: proj(project, a), session: sess(session, a), idempotency: { key: 'ka', requestHash: 'ha' } }),
      repo.saveCheckpoint({ ownerScope: ownerA, checkpoint: b, project: proj(project, b), session: sess(session, b), idempotency: { key: 'kb', requestHash: 'hb' } }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one writer commits');
    assert.equal(rejected.length, 1, 'the loser is rejected');
    assert.ok(rejected[0].reason.code?.startsWith('checkpoint-'), `loser is a checkpoint conflict, got ${rejected[0].reason.code}`);
    // Exactly one checkpoint is durably stored; the head is a real revision 1.
    assert.equal((await repo.listCheckpoints({ ownerScope: ownerA, projectId: project.id })).length, 1);
  });
});

describe('storage unavailable', () => {
  it('rejects when the database is unreachable', async () => {
    const deadPool = new pg.Pool({ connectionString: 'postgres://noosphere:noosphere@127.0.0.1:1/none', connectionTimeoutMillis: 500 });
    const repo = new PostgresProjectMemoryRepository({ pool: deadPool });
    try {
      await assert.rejects(repo.getProject({ ownerScope: ownerA, projectId: 'prj_1' }));
      await assert.rejects(repo.createProject({ ownerScope: ownerA, project: validProject() }));
    } finally {
      await deadPool.end();
    }
  });
});

describe('cross-owner isolation (end to end)', () => {
  it('never lets one owner read, delete, or checkpoint another owner project', async () => {
    const repo = new PostgresProjectMemoryRepository({ pool: harness.pool });
    const project = validProject();
    await repo.createProject({ ownerScope: ownerA, project });
    assert.equal(await repo.getProject({ ownerScope: ownerB, projectId: project.id }), null);
    await assert.rejects(repo.deleteProject({ ownerScope: ownerB, projectId: project.id }), (e) => e.name === 'RepositoryNotFoundError');
    await assert.rejects(repo.inspectProjectState({ ownerScope: ownerB, projectId: project.id }), (e) => e.name === 'RepositoryNotFoundError');
    const checkpoint = validCheckpoint();
    await assert.rejects(
      repo.saveCheckpoint({ ownerScope: ownerB, checkpoint, project: proj(project, checkpoint), session: undefined, idempotency: { key: 'k', requestHash: 'h' } }),
      (e) => e.name === 'RepositoryNotFoundError',
    );
    // Owner A's project is untouched.
    assert.ok(await repo.getProject({ ownerScope: ownerA, projectId: project.id }));
  });
});
