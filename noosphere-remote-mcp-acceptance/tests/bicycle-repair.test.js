import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { validCheckpoint } from '@noosphere/remote-mcp-contracts/tests/fixtures.js';
import { clock, startAcceptance, structured } from './harness.js';

const AT = '2026-07-20T10:00:00.000Z';

// Cross-client continuity: one owner, two different client apps. Client A
// (chatgpt) establishes the project and a durable checkpoint; client B (claude)
// opens an independent session later and resumes exactly A's head.
describe('Bicycle Repair — cross-client continuity', () => {
  let h;
  before(async () => { h = await startAcceptance({ now: clock(AT) }); });
  after(async () => { await h.close(); });

  it('client B (claude) resumes the checkpoint client A (chatgpt) saved', async () => {
    const owner = await h.token({ sub: 'rider' });

    // Client A: create project + session, save a durable checkpoint.
    const a = await h.connect(owner, 'chatgpt');
    const project = structured(await a.call('create_project', { name: 'Bicycle Repair' })).project;
    assert.equal(project.normalized_name, 'bicycle repair');
    const sessionA = structured(await a.call('create_session', { project_id: project.id, source_client: 'chatgpt' })).session;
    const checkpoint = validCheckpoint({ id: 'chk_root', project_id: project.id, session_id: sessionA.id, current_status: 'Hydraulic line inspected; bleed pending.', created_at: AT });
    const saved = structured(await a.call('save_checkpoint', { project_id: project.id, session_id: sessionA.id, checkpoint, idempotency_key: 'a-1' }));
    assert.equal(saved.deduplicated, false);
    await a.close();

    // Client B: a different client app, same owner, brand-new session. Resume
    // must return A's head as untrusted persisted data, no local state shared.
    const b = await h.connect(owner, 'claude');
    const found = structured(await b.call('find_projects', { query: 'Bicycle Repair' }));
    assert.equal(found.result, 'resolved');
    assert.equal(found.project.id, project.id);

    const resumed = structured(await b.call('resume_project', { project_id: project.id }));
    assert.equal(resumed.latest_checkpoint.id, 'chk_root');
    assert.equal(resumed.latest_checkpoint.current_status, 'Hydraulic line inspected; bleed pending.');
    assert.equal(resumed.content_trust, 'untrusted-persisted-data');
    assert.equal(resumed.freshness, 'fresh');
    assert.deepEqual(resumed.warnings, []);
    await b.close();
  });

  it('a retry-safe save from a reconnecting client replays, not duplicates', async () => {
    const owner = await h.token({ sub: 'rider2' });
    const a = await h.connect(owner, 'chatgpt');
    const project = structured(await a.call('create_project', { name: 'Bicycle Repair Two' })).project;
    const session = structured(await a.call('create_session', { project_id: project.id, source_client: 'chatgpt' })).session;
    const checkpoint = validCheckpoint({ id: 'chk_root', project_id: project.id, session_id: session.id, created_at: AT });
    const args = { project_id: project.id, session_id: session.id, checkpoint, idempotency_key: 'dedupe-1' };
    const first = structured(await a.call('save_checkpoint', args));
    const second = structured(await a.call('save_checkpoint', args));
    assert.equal(first.deduplicated, false);
    assert.equal(second.deduplicated, true);
    await a.close();
  });
});
