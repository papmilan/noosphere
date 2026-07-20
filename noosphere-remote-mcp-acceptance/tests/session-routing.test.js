import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemoryProjectMemoryRepository } from '@noosphere/remote-mcp-contracts/index.js';
import { clock, startAcceptance } from './harness.js';
import { rawAdapter } from './adapters.js';

const AT = '2026-07-20T10:00:00.000Z';
const WRITES = new Set(['createProject', 'createSession', 'saveCheckpoint', 'replaceSession', 'replaceProject', 'deleteProject']);

// Repository that counts write-method calls, so a rejected request can be
// proven to perform no mutation.
function recordingRepository() {
  const inner = new InMemoryProjectMemoryRepository();
  const writes = { count: 0 };
  const proxy = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function') return (...args) => { if (WRITES.has(prop)) writes.count += 1; return value.apply(target, args); };
      return value;
    },
  });
  return { proxy, writes };
}

describe('Session routing (raw JSON-RPC client)', () => {
  it('rejects an unknown session id with HTTP 404', async () => {
    const h = await startAcceptance({ now: clock(AT) });
    try {
      const raw = rawAdapter({ mcpUrl: h.mcpUrl, token: await h.token({ sub: 'a' }) });
      await raw.connect();
      const res = await raw.raw.send('tools/list', {}, { sessionId: 'not-a-real-session' });
      assert.equal(res.status, 404);
      await raw.close();
    } finally { await h.close(); }
  });

  it('rejects owner A\'s session id reused under a valid owner B token with HTTP 403 and performs no mutation', async () => {
    const { proxy, writes } = recordingRepository();
    const h = await startAcceptance({ now: clock(AT), repository: proxy });
    try {
      const a = rawAdapter({ mcpUrl: h.mcpUrl, token: await h.token({ sub: 'ownerA' }) });
      await a.connect();
      const sidA = a.sessionId;
      assert.ok(sidA, 'owner A established a session id');
      // Owner A does one legitimate write so the counter is exercised.
      await a.callTool('create_project', { name: 'Owner A Project' });
      const writesAfterSetup = writes.count;
      assert.ok(writesAfterSetup >= 1);

      // Owner B: valid token, but reusing owner A's session id.
      const b = rawAdapter({ mcpUrl: h.mcpUrl, token: await h.token({ sub: 'ownerB' }) });
      const attempt = await b.raw.send('tools/call', { name: 'create_project', arguments: { name: 'Injected By B' } }, { sessionId: sidA });
      assert.equal(attempt.status, 403);
      assert.equal(writes.count, writesAfterSetup, 'the foreign-owner request must perform no mutation');
      await a.close();
    } finally { await h.close(); }
  });
});
