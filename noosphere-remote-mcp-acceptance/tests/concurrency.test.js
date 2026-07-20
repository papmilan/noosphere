import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validCheckpoint } from '@noosphere/remote-mcp-contracts/tests/fixtures.js';
import { clock, startAcceptance, structured } from './harness.js';

const AT = '2026-07-20T10:00:00.000Z';

// Determinism here comes from structural coordination — a single `Promise.all`
// barrier and the event loop serializing the repository's synchronous
// idempotency check-and-set — never from sleeps or wall-clock timing.
describe('Deterministic bounded concurrency', () => {
  it('isolates concurrent requests from different owners with no cross-owner leakage', async () => {
    const h = await startAcceptance({ now: clock(AT) });
    try {
      const alice = await h.connect(await h.token({ sub: 'alice' }), 'chatgpt');
      const bob = await h.connect(await h.token({ sub: 'bob' }), 'claude');

      const [ap, bp] = await Promise.all([
        alice.call('create_project', { name: 'Alice Concurrent' }),
        bob.call('create_project', { name: 'Bob Concurrent' }),
      ]);
      const aliceId = structured(ap).project.id;
      const bobId = structured(bp).project.id;

      // Concurrent cross-reads: each owner may read only its own project; the
      // other owner's id collapses to a typed not-found (no existence oracle).
      const [aliceSelf, aliceCross, bobSelf, bobCross] = await Promise.all([
        alice.call('get_project', { project_id: aliceId }),
        alice.call('get_project', { project_id: bobId }),
        bob.call('get_project', { project_id: bobId }),
        bob.call('get_project', { project_id: aliceId }),
      ]);
      assert.equal(structured(aliceSelf).project.id, aliceId);
      assert.equal(structured(bobSelf).project.id, bobId);
      for (const denied of [aliceCross, bobCross]) {
        assert.equal(denied.isError, true);
        assert.equal(denied.structuredContent.error.code, 'not-found');
      }
      await alice.close();
      await bob.close();
    } finally {
      await h.close();
    }
  });

  it('creates exactly one checkpoint for concurrent identical idempotent retries', async () => {
    const h = await startAcceptance({ now: clock(AT) });
    try {
      const c = await h.connect(await h.token({ sub: 'retry' }), 'chatgpt');
      const project = structured(await c.call('create_project', { name: 'Concurrent Retry' })).project;
      const session = structured(await c.call('create_session', { project_id: project.id, source_client: 'chatgpt' })).session;
      const checkpoint = validCheckpoint({ id: 'chk_retry', project_id: project.id, session_id: session.id, created_at: AT });
      const args = { project_id: project.id, session_id: session.id, checkpoint, idempotency_key: 'same-key' };

      const N = 8;
      const results = (await Promise.all(Array.from({ length: N }, () => c.call('save_checkpoint', args)))).map(structured);

      // Every concurrent result agrees on the same durable checkpoint.
      assert.ok(results.every((r) => r.checkpoint.id === 'chk_retry'), 'all retries observe the same checkpoint id');
      // Exactly one first-write; the remaining N-1 are deduplicated replays.
      assert.equal(results.filter((r) => r.deduplicated === false).length, 1, 'exactly one non-deduplicated write');
      assert.equal(results.filter((r) => r.deduplicated === true).length, N - 1);

      // Observable via the public list: exactly one checkpoint was created.
      const listed = structured(await c.call('list_checkpoints', { project_id: project.id }));
      assert.equal(listed.checkpoints.length, 1);
      await c.close();
    } finally {
      await h.close();
    }
  });
});
