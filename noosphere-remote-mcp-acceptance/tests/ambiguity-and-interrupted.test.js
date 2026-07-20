import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { validCheckpoint } from '@noosphere/remote-mcp-contracts/tests/fixtures.js';
import { clock, startAcceptance, structured } from './harness.js';

const AT = '2026-07-20T10:00:00.000Z';

describe('Ambiguity never silently resolves', () => {
  let h, owner;
  before(async () => { h = await startAcceptance({ now: clock(AT) }); owner = await h.token({ sub: 'ambi' }); });
  after(async () => { await h.close(); });

  it('a discovery substring matching two projects is ambiguous; an exact name resolves', async () => {
    const c = await h.connect(owner, 'chatgpt');
    await c.call('create_project', { name: 'Bicycle Repair' });
    await c.call('create_project', { name: 'Bicycle Maintenance' });

    const ambiguous = structured(await c.call('find_projects', { query: 'bicycle' }));
    assert.equal(ambiguous.result, 'ambiguous');
    assert.ok(ambiguous.candidates.length >= 2);

    const resolved = structured(await c.call('find_projects', { query: 'Bicycle Repair' }));
    assert.equal(resolved.result, 'resolved');
    assert.equal(resolved.project.normalized_name, 'bicycle repair');
    await c.close();
  });
});

describe('Interrupted session yields a bounded warning', () => {
  let h, owner;
  before(async () => { h = await startAcceptance({ now: clock(AT) }); owner = await h.token({ sub: 'interrupted' }); });
  after(async () => { await h.close(); });

  it('resume of a project whose latest session was interrupted warns without projecting an inconsistent head', async () => {
    const c = await h.connect(owner, 'chatgpt');
    const project = structured(await c.call('create_project', { name: 'Bicycle Repair' })).project;
    const session = structured(await c.call('create_session', { project_id: project.id, source_client: 'chatgpt' })).session;
    const checkpoint = validCheckpoint({ id: 'chk_root', project_id: project.id, session_id: session.id, created_at: AT });
    await c.call('save_checkpoint', { project_id: project.id, session_id: session.id, checkpoint, idempotency_key: 's1' });

    // Model the earlier client's session being interrupted after the checkpoint,
    // by mutating persisted state directly (the resume under test is over the
    // transport). Head/session-link invariants are preserved.
    const ownerScope = await h.ownerScopeFor('interrupted');
    const persisted = await h.repository.getSession({ ownerScope, projectId: project.id, sessionId: session.id });
    await h.repository.replaceSession({ ownerScope, projectId: project.id, sessionId: session.id, session: { ...persisted, status: 'interrupted' } });

    const resumed = structured(await c.call('resume_project', { project_id: project.id }));
    assert.equal(resumed.latest_checkpoint.id, 'chk_root'); // head still projected, not dropped
    assert.equal(resumed.freshness, 'incomplete');
    assert.ok(resumed.warnings.some((w) => w.code === 'interrupted-session'));
    // Warning conforms to the published contract shape.
    for (const w of resumed.warnings) {
      assert.equal(w.schema_version, 'noosphere.project-memory/1.0.0');
      assert.equal(typeof w.message, 'string');
    }
    assert.equal(resumed.content_trust, 'untrusted-persisted-data');
    await c.close();
  });
});
