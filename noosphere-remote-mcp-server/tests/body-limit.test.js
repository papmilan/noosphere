import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemoryProjectMemoryRepository } from '@noosphere/remote-mcp-contracts/index.js';
import { startServer } from './harness.js';

const LIMIT = 128;

// A repository whose every method call is counted, so a rejected request can be
// proven to never reach tool/service dispatch.
function recordingRepository() {
  const inner = new InMemoryProjectMemoryRepository();
  const calls = { count: 0 };
  const proxy = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function') return (...args) => { calls.count += 1; return value.apply(target, args); };
      return value;
    },
  });
  return { proxy, calls };
}

// n ASCII bytes of valid JSON (a JSON string literal) → length === byte length.
const validJsonOfLength = (n) => `"${'a'.repeat(n - 2)}"`;
// n ASCII bytes that are NOT valid JSON.
const invalidJsonOfLength = (n) => 'a'.repeat(n);

async function post(url, tok, body, extraHeaders = {}) {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}`, ...extraHeaders }, body });
}

describe('request body size limit', () => {
  it('accepts a body of exactly the configured limit (not 413)', async () => {
    const h = await startServer({ maxBodyBytes: LIMIT });
    try {
      const body = validJsonOfLength(LIMIT);
      assert.equal(Buffer.byteLength(body), LIMIT);
      const res = await post(h.mcpUrl, await h.token(), body);
      assert.notEqual(res.status, 413);
    } finally { await h.close(); }
  });

  it('rejects a body over the limit with 413', async () => {
    const h = await startServer({ maxBodyBytes: LIMIT });
    try {
      const res = await post(h.mcpUrl, await h.token(), invalidJsonOfLength(LIMIT + 1));
      assert.equal(res.status, 413);
      assert.equal((await res.json()).error, 'payload-too-large');
    } finally { await h.close(); }
  });

  it('keeps malformed JSON within the limit as a distinct 400', async () => {
    const h = await startServer({ maxBodyBytes: LIMIT });
    try {
      const res = await post(h.mcpUrl, await h.token(), invalidJsonOfLength(LIMIT - 4));
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error, 'invalid-json');
    } finally { await h.close(); }
  });

  it('rejects malformed UTF-8 even when replacement decoding would form valid JSON', async () => {
    const h = await startServer({ maxBodyBytes: LIMIT });
    try {
      const body = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]);
      const res = await post(h.mcpUrl, await h.token(), body);
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error, 'invalid-json');
    } finally { await h.close(); }
  });

  it('does not reach tool/service dispatch after a 413 rejection', async () => {
    const { proxy, calls } = recordingRepository();
    const h = await startServer({ maxBodyBytes: LIMIT, repository: proxy });
    try {
      // A structurally valid, oversized tool-call payload must be rejected before dispatch.
      const oversized = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_project', arguments: { name: 'x'.repeat(LIMIT * 4) } } });
      assert.ok(Buffer.byteLength(oversized) > LIMIT);
      const res = await post(h.mcpUrl, await h.token(), oversized);
      assert.equal(res.status, 413);
      assert.equal(calls.count, 0);
    } finally { await h.close(); }
  });

  it('never leaks the bearer token or body content into logs on a 413', async () => {
    const lines = [];
    const marker = 'SENSITIVE_BODY_MARKER';
    const h = await startServer({ maxBodyBytes: LIMIT, deps: { logger: (l) => lines.push(l) } });
    try {
      const tok = await h.token();
      const body = `"${marker}${'a'.repeat(LIMIT)}"`; // > LIMIT, contains the marker
      const res = await post(h.mcpUrl, tok, body);
      assert.equal(res.status, 413);
      const serialized = JSON.stringify(lines);
      assert.ok(!serialized.includes(tok), 'token must not appear in logs');
      assert.ok(!serialized.includes(marker), 'body content must not appear in logs');
      assert.ok(lines.some((l) => l.headers.authorization === '[redacted]'));
    } finally { await h.close(); }
  });

  it('cleans up an over-limit request without an unhandled rejection', async () => {
    const rejections = [];
    const onRejection = (reason) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    const h = await startServer({ maxBodyBytes: LIMIT });
    try {
      const res = await post(h.mcpUrl, await h.token(), invalidJsonOfLength(LIMIT * 8));
      assert.equal(res.status, 413);
      await new Promise((r) => setImmediate(r)); // let any stray rejection surface
      assert.equal(rejections.length, 0);
    } finally {
      await h.close();
      process.removeListener('unhandledRejection', onRejection);
    }
  });
});
