import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { loadConfig } from '../src/config.js';
import { startServer } from './harness.js';

describe('config validation', () => {
  it('rejects missing audience, missing metadata url, and production + test identities', () => {
    assert.throws(() => loadConfig({ issuers: { a: 1 }, resourceMetadataUrl: 'u' }), /config-requires-audience/);
    assert.throws(() => loadConfig({ audience: 'a', issuers: { a: 1 } }), /config-requires-resource-metadata-url/);
    assert.throws(() => loadConfig({ audience: 'a', issuers: { a: 1 }, resourceMetadataUrl: 'u', production: true, allowTestIdentities: true }), /production-forbids-test-identities/);
  });
});

describe('HTTP surface', () => {
  let h;
  before(async () => { h = await startServer(); });
  after(async () => { await h.close(); });

  it('serves protected-resource metadata (RFC 9728)', async () => {
    const res = await fetch(`${h.baseUrl}/.well-known/oauth-protected-resource`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.resource, 'https://noosphere.example/project-memory');
    assert.deepEqual(body.authorization_servers, ['https://issuer.example/']);
  });

  it('answers health and readiness', async () => {
    assert.equal((await fetch(`${h.baseUrl}/healthz`)).status, 200);
    assert.equal((await fetch(`${h.baseUrl}/readyz`)).status, 200);
  });

  it('returns 401 with WWW-Authenticate for an unauthenticated /mcp call', async () => {
    const res = await fetch(h.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate') || '', /Bearer resource_metadata=/);
  });

  it('rejects an invalid bearer token as 401', async () => {
    const res = await fetch(h.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer not-a-jwt' }, body: '{}' });
    assert.equal(res.status, 401);
  });

  it('rejects a disallowed Origin as 403 before auth', async () => {
    const res = await fetch(h.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
    assert.equal(res.status, 403);
  });
});

describe('correlation logging redaction', () => {
  it('never emits the bearer token to the request log', async () => {
    const lines = [];
    const h = await startServer({ deps: { logger: (line) => lines.push(line) } });
    try {
      const tok = await h.token();
      await fetch(h.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: '{}' });
      assert.ok(lines.length > 0);
      const serialized = JSON.stringify(lines);
      assert.ok(!serialized.includes(tok), 'token must not appear in logs');
      assert.ok(lines.some((l) => l.headers.authorization === '[redacted]'));
      assert.ok(lines.every((l) => l.correlationId), 'every log line carries a correlation id');
    } finally {
      await h.close();
    }
  });
});
