import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { validCheckpoint } from '@noosphere/remote-mcp-contracts/tests/fixtures.js';
import { clock, startAcceptance, structured } from './harness.js';

const AT = '2026-07-20T10:00:00.000Z';

async function seedProject(client, name) {
  const project = structured(await client.call('create_project', { name })).project;
  const session = structured(await client.call('create_session', { project_id: project.id, source_client: 'chatgpt' })).session;
  return { project, session };
}

describe('Architecture Phase 1→2 progression', () => {
  let h, owner;
  before(async () => { h = await startAcceptance({ now: clock(AT) }); owner = await h.token({ sub: 'architect' }); });
  after(async () => { await h.close(); });

  it('resume and summary reflect the Phase 2 head, never a stale Phase 1', async () => {
    const c = await h.connect(owner, 'chatgpt');
    const { project, session } = await seedProject(c, 'Architecture');

    const p1 = validCheckpoint({ id: 'chk_phase1', project_id: project.id, session_id: session.id, revision: 1, previous_checkpoint_id: null, current_status: 'Phase 1: context and constraints gathered.', created_at: AT });
    await c.call('save_checkpoint', { project_id: project.id, session_id: session.id, checkpoint: p1, idempotency_key: 'p1' });
    const p2 = validCheckpoint({ id: 'chk_phase2', project_id: project.id, session_id: session.id, revision: 2, previous_checkpoint_id: 'chk_phase1', current_status: 'Phase 2: component design in progress.', created_at: AT });
    await c.call('save_checkpoint', { project_id: project.id, session_id: session.id, checkpoint: p2, idempotency_key: 'p2' });

    const resumed = structured(await c.call('resume_project', { project_id: project.id }));
    assert.equal(resumed.latest_checkpoint.id, 'chk_phase2');
    assert.match(resumed.latest_checkpoint.current_status, /Phase 2/);

    const { summary } = structured(await c.call('get_project_summary', { project_id: project.id }));
    assert.equal(summary.latest_checkpoint_id, 'chk_phase2');
    assert.equal(summary.checkpoint_count, 2);
    assert.match(summary.current_status, /Phase 2/);

    const list = structured(await c.call('list_checkpoints', { project_id: project.id }));
    assert.equal(list.checkpoints.length, 2);
    assert.equal(list.content_trust, 'untrusted-persisted-data');
    await c.close();
  });
});

describe('Separate projects stay isolated', () => {
  let h, owner;
  before(async () => { h = await startAcceptance({ now: clock(AT) }); owner = await h.token({ sub: 'multi' }); });
  after(async () => { await h.close(); });

  it('resume of one project never surfaces the other, and cross-project checkpoint access is not-found', async () => {
    const c = await h.connect(owner, 'chatgpt');
    const a = await seedProject(c, 'Bicycle Repair');
    const b = await seedProject(c, 'Architecture');
    const ca = validCheckpoint({ id: 'chk_a', project_id: a.project.id, session_id: a.session.id, created_at: AT });
    const cb = validCheckpoint({ id: 'chk_b', project_id: b.project.id, session_id: b.session.id, created_at: AT });
    await c.call('save_checkpoint', { project_id: a.project.id, session_id: a.session.id, checkpoint: ca, idempotency_key: 'a' });
    await c.call('save_checkpoint', { project_id: b.project.id, session_id: b.session.id, checkpoint: cb, idempotency_key: 'b' });

    assert.equal(structured(await c.call('resume_project', { project_id: a.project.id })).latest_checkpoint.id, 'chk_a');
    assert.equal(structured(await c.call('resume_project', { project_id: b.project.id })).latest_checkpoint.id, 'chk_b');

    // A checkpoint id from project B cannot be read through project A.
    const cross = await c.call('get_checkpoint', { project_id: a.project.id, checkpoint_id: 'chk_b' });
    assert.equal(cross.isError, true);
    assert.equal(cross.structuredContent.error.code, 'not-found');
    await c.close();
  });
});
