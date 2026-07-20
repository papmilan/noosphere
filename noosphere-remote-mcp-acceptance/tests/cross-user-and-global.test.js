import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { validCheckpoint } from '@noosphere/remote-mcp-contracts/tests/fixtures.js';
import { clock, startAcceptance, structured } from './harness.js';

const AT = '2026-07-20T10:00:00.000Z';

describe('Cross-user denial', () => {
  let h;
  before(async () => { h = await startAcceptance({ now: clock(AT) }); });
  after(async () => { await h.close(); });

  it('a second owner cannot read, resume, or find the first owner\'s project', async () => {
    const alice = await h.connect(await h.token({ sub: 'alice' }), 'chatgpt');
    const project = structured(await alice.call('create_project', { name: 'Alice Private' })).project;
    const session = structured(await alice.call('create_session', { project_id: project.id, source_client: 'chatgpt' })).session;
    const checkpoint = validCheckpoint({ id: 'chk_root', project_id: project.id, session_id: session.id, created_at: AT });
    await alice.call('save_checkpoint', { project_id: project.id, session_id: session.id, checkpoint, idempotency_key: 'a' });
    await alice.close();

    const mallory = await h.connect(await h.token({ sub: 'mallory' }), 'claude');
    for (const [tool, args] of [
      ['get_project', { project_id: project.id }],
      ['resume_project', { project_id: project.id }],
      ['get_checkpoint', { project_id: project.id, checkpoint_id: 'chk_root' }],
      ['get_project_summary', { project_id: project.id }],
    ]) {
      const res = await mallory.call(tool, args);
      assert.equal(res.isError, true, `${tool} must deny`);
      assert.equal(res.structuredContent.error.code, 'not-found', `${tool} must be a typed not-found, no existence oracle`);
    }
    // No discovery leak either: Mallory owns nothing matching the name.
    const found = structured(await mallory.call('find_projects', { query: 'Alice Private' }));
    assert.equal(found.result, 'none');
    await mallory.close();
  });
});

describe('Global verification guarantees', () => {
  let h, owner;
  before(async () => { h = await startAcceptance({ now: clock(AT) }); owner = await h.token({ sub: 'guarantees' }); });
  after(async () => { await h.close(); });

  it('achieves full continuity over a network MCP client with no Git repo, folder, CLI, or user-run MCP process', async () => {
    // Every interaction below is an MCP protocol call over HTTP against a server
    // holding only injected in-memory state — no local working directory, Git
    // repository, CLI invocation, or user-spawned MCP process is involved.
    const c = await h.connect(owner, 'chatgpt');
    const project = structured(await c.call('create_project', { name: 'Bicycle Repair' })).project;
    const session = structured(await c.call('create_session', { project_id: project.id, source_client: 'chatgpt' })).session;
    const checkpoint = validCheckpoint({ id: 'chk_root', project_id: project.id, session_id: session.id, created_at: AT });
    await c.call('save_checkpoint', { project_id: project.id, session_id: session.id, checkpoint, idempotency_key: 'g1' });
    const resumed = structured(await c.call('resume_project', { project_id: project.id }));
    assert.equal(resumed.latest_checkpoint.id, 'chk_root');
    await c.close();
  });

  it('marks recalled checkpoint content as untrusted persisted data', async () => {
    const c = await h.connect(owner, 'chatgpt');
    const found = structured(await c.call('find_projects', { query: 'Bicycle Repair' }));
    const got = structured(await c.call('get_checkpoint', { project_id: found.project.id, checkpoint_id: 'chk_root' }));
    assert.equal(got.content_trust, 'untrusted-persisted-data');
    const latest = structured(await c.call('get_latest_checkpoint', { project_id: found.project.id }));
    assert.equal(latest.content_trust, 'untrusted-persisted-data');
    await c.close();
  });

  it('rejects a checkpoint that smuggles hidden reasoning or transcript capture', async () => {
    const c = await h.connect(owner, 'chatgpt');
    const project = structured(await c.call('create_project', { name: 'No Transcript Capture' })).project;
    const session = structured(await c.call('create_session', { project_id: project.id, source_client: 'chatgpt' })).session;
    for (const forbidden of ['transcript', 'chain_of_thought']) {
      const checkpoint = { ...validCheckpoint({ id: 'chk_bad', project_id: project.id, session_id: session.id, created_at: AT }), [forbidden]: 'private model internals' };
      const res = await c.call('save_checkpoint', { project_id: project.id, session_id: session.id, checkpoint, idempotency_key: `bad-${forbidden}` });
      assert.equal(res.isError, true, `${forbidden} key must be rejected`);
      assert.equal(res.structuredContent.error.code, 'invalid-argument');
    }
    await c.close();
  });
});
