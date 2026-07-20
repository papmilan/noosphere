import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validCheckpoint } from '@noosphere/remote-mcp-contracts/tests/fixtures.js';
import { clock, startAcceptance } from './harness.js';
import { rawAdapter, sdkAdapter, structured } from './adapters.js';

const AT = '2026-07-20T10:00:00.000Z';

// Idempotency-key semantics, proven end-to-end over the public MCP surface
// through both independent client transports. The only "internal" assertion is
// a public `list_checkpoints` count — no repository or service is touched.
describe('Idempotency key conflict (both client adapters)', () => {
  for (const factory of [sdkAdapter, rawAdapter]) {
    it(`replays an identical payload and rejects a conflicting payload under the same key [${factory.name}]`, async () => {
      const h = await startAcceptance({ now: clock(AT) });
      try {
        const a = factory({ mcpUrl: h.mcpUrl, token: await h.token({ sub: 'idem' }) });
        await a.connect();
        const project = structured(await a.callTool('create_project', { name: 'Idempotent Save' })).project;
        const session = structured(await a.callTool('create_session', { project_id: project.id, source_client: 'chatgpt' })).session;

        const payloadA = validCheckpoint({ id: 'chk_one', project_id: project.id, session_id: session.id, current_status: 'Payload A durable state.', created_at: AT });
        const argsA = { project_id: project.id, session_id: session.id, checkpoint: payloadA, idempotency_key: 'K' };

        // 1. First write commits payload A.
        const first = structured(await a.callTool('save_checkpoint', argsA));
        assert.equal(first.deduplicated, false);
        assert.equal(first.checkpoint.id, 'chk_one');

        // 2. Same key + identical payload → deduplicated replay, not a new write.
        const replay = structured(await a.callTool('save_checkpoint', argsA));
        assert.equal(replay.deduplicated, true);
        assert.equal(replay.checkpoint.id, 'chk_one');

        // 3. Same key + a materially different payload → typed idempotency-conflict.
        const payloadB = { ...payloadA, current_status: 'Payload B — a different durable state.' };
        const conflict = await a.callTool('save_checkpoint', { project_id: project.id, session_id: session.id, checkpoint: payloadB, idempotency_key: 'K' });
        assert.equal(conflict.isError, true);
        assert.equal(conflict.structuredContent.error.code, 'idempotency-conflict');

        // 4. The conflict created no second checkpoint (public list is the oracle).
        const listed = structured(await a.callTool('list_checkpoints', { project_id: project.id }));
        assert.equal(listed.checkpoints.length, 1);

        // 5. The original checkpoint is intact and retrievable, unchanged by B.
        const got = structured(await a.callTool('get_checkpoint', { project_id: project.id, checkpoint_id: 'chk_one' }));
        assert.equal(got.checkpoint.current_status, 'Payload A durable state.');
        await a.close();
      } finally {
        await h.close();
      }
    });
  }
});
