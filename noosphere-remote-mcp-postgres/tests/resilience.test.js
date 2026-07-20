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

describe('concurrent idempotent saveCheckpoint (separate connections)', () => {
  it('replays identical simultaneous retries: one success, one dedup, one checkpoint, one receipt', async () => {
    const repo = new PostgresProjectMemoryRepository({ pool: harness.pool });
    // Repeat to expose interleaving flakiness.
    for (let i = 0; i < 25; i += 1) {
      const project = validProject({ id: `prj_${i}`, normalized_name: `p${i}` });
      const session = validSession({ id: `ses_${i}`, project_id: `prj_${i}` });
      const checkpoint = validCheckpoint({ id: `chk_${i}`, project_id: `prj_${i}`, session_id: `ses_${i}` });
      await repo.createProject({ ownerScope: ownerA, project });
      await repo.createSession({ ownerScope: ownerA, session });
      const input = { ownerScope: ownerA, checkpoint, project: proj(project, checkpoint), session: sess(session, checkpoint), idempotency: { key: `k_${i}`, requestHash: `h_${i}` } };

      const results = await Promise.allSettled([repo.saveCheckpoint({ ...input }), repo.saveCheckpoint({ ...input })]);
      assert.equal(results.filter((r) => r.status === 'rejected').length, 0, `no conflict on identical retry (iter ${i})`);
      const dedup = results.map((r) => r.value.deduplicated).sort();
      assert.deepEqual(dedup, [false, true], `exactly one success + one replay (iter ${i})`);

      assert.equal((await repo.listCheckpoints({ ownerScope: ownerA, projectId: project.id })).length, 1, 'one checkpoint');
      const receipts = await harness.pool.query("select count(*)::int n from idempotency_receipts where owner_scope = $1 and operation = 'save_checkpoint' and idempotency_key = $2", [ownerA, `k_${i}`]);
      assert.equal(receipts.rows[0].n, 1, 'one receipt');
      const revs = await harness.pool.query('select count(*)::int n from checkpoints where owner_scope = $1 and project_id = $2 and revision = 1', [ownerA, project.id]);
      assert.equal(revs.rows[0].n, 1, 'no duplicate revision');
    }
  });

  it('returns idempotency-conflict for concurrent same-key different-payload retries', async () => {
    const repo = new PostgresProjectMemoryRepository({ pool: harness.pool });
    for (let i = 0; i < 15; i += 1) {
      const project = validProject({ id: `prj_${i}`, normalized_name: `p${i}` });
      await repo.createProject({ ownerScope: ownerA, project });
      const a = validCheckpoint({ id: `chk_a_${i}`, project_id: `prj_${i}`, session_id: null });
      const b = validCheckpoint({ id: `chk_b_${i}`, project_id: `prj_${i}`, session_id: null });
      const mk = (c, hash) => ({ ownerScope: ownerA, checkpoint: c, project: { ...project, updated_at: later, last_activity_at: later, latest_checkpoint_id: c.id }, session: undefined, idempotency: { key: `k_${i}`, requestHash: hash } });
      const results = await Promise.allSettled([repo.saveCheckpoint(mk(a, 'ha')), repo.saveCheckpoint(mk(b, 'hb'))]);
      const ok = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      assert.equal(ok.length, 1, `one commits (iter ${i})`);
      assert.equal(rejected.length, 1, `one rejected (iter ${i})`);
      // The loser is a conflict (idempotency-conflict when it lost the receipt race,
      // or a checkpoint conflict when it lost the head race) — never a silent success.
      assert.ok(['idempotency-conflict', 'checkpoint-conflict', 'checkpoint-predecessor-conflict'].includes(rejected[0].reason.code), `conflict code, got ${rejected[0].reason.code}`);
      assert.equal((await repo.listCheckpoints({ ownerScope: ownerA, projectId: project.id })).length, 1);
    }
  });
});

describe('project delete racing child inserts leaves no orphan', () => {
  it('createSession vs deleteProject: child is either cascaded or fails cleanly', async () => {
    const repo = new PostgresProjectMemoryRepository({ pool: harness.pool });
    for (let i = 0; i < 25; i += 1) {
      const project = validProject({ id: `prj_${i}`, normalized_name: `p${i}` });
      const session = validSession({ id: `ses_${i}`, project_id: `prj_${i}` });
      await repo.createProject({ ownerScope: ownerA, project });
      const ops = i % 2 === 0
        ? [repo.deleteProject({ ownerScope: ownerA, projectId: project.id }), repo.createSession({ ownerScope: ownerA, session })]
        : [repo.createSession({ ownerScope: ownerA, session }), repo.deleteProject({ ownerScope: ownerA, projectId: project.id })];
      await Promise.allSettled(ops);
      const orphans = await harness.pool.query('select count(*)::int n from sessions where owner_scope = $1 and project_id = $2 and not exists (select 1 from projects p where p.owner_scope = sessions.owner_scope and p.id = sessions.project_id)', [ownerA, project.id]);
      assert.equal(orphans.rows[0].n, 0, `no orphan session (iter ${i})`);
    }
  });

  it('setRetentionMarker vs deleteProject: marker is either cascaded or fails cleanly', async () => {
    const repo = new PostgresProjectMemoryRepository({ pool: harness.pool });
    for (let i = 0; i < 25; i += 1) {
      const project = validProject({ id: `prj_${i}`, normalized_name: `p${i}` });
      await repo.createProject({ ownerScope: ownerA, project });
      const ops = i % 2 === 0
        ? [repo.deleteProject({ ownerScope: ownerA, projectId: project.id }), repo.setRetentionMarker({ ownerScope: ownerA, projectId: project.id, retainUntil: '2999-01-01T00:00:00.000Z' })]
        : [repo.setRetentionMarker({ ownerScope: ownerA, projectId: project.id, retainUntil: '2999-01-01T00:00:00.000Z' }), repo.deleteProject({ ownerScope: ownerA, projectId: project.id })];
      await Promise.allSettled(ops);
      const orphans = await harness.pool.query('select count(*)::int n from retention_markers where owner_scope = $1 and project_id = $2 and not exists (select 1 from projects p where p.owner_scope = retention_markers.owner_scope and p.id = retention_markers.project_id)', [ownerA, project.id]);
      assert.equal(orphans.rows[0].n, 0, `no orphan marker (iter ${i})`);
    }
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
