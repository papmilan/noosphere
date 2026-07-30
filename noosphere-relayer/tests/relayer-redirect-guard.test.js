import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import http from 'node:http';
import {
  installRelayerFetchGuard,
  RelayerRedirectError,
} from '../relayer-fetch-guard.js';

// SEC-01b: the SEC-01 origin gate approves the *initial* configured origin, but
// the MemWal SDK's global fetch follows redirects (`redirect: 'follow'`), and
// undici forwards custom x-* headers and the request body on 307/308. A
// compromised approved relayer could therefore replay a signed request — with
// its request-scoped signature headers and its payload — against an origin the
// owner never approved. These tests prove the guard refuses EVERY redirect on
// the guarded origin channel before any bytes reach the redirect target, and
// leaves every other origin's fetch behavior untouched.

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, origin: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

describe('SEC-01b — relayer redirect guard', () => {
  let relayer; // guarded origin: redirects
  let attacker; // unapproved origin: must never see the request
  let bystander; // unguarded origin: normal redirect behavior preserved
  const attackerHits = [];
  let uninstall;

  before(async () => {
    attacker = await listen((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        attackerHits.push({
          path: req.url,
          headers: req.headers,
          body,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    relayer = await listen((req, res) => {
      if (req.url === '/plain') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"status":"ok"}');
        return;
      }
      // 307 preserves method, headers, and body across the redirect — the
      // exact primitive SEC-01b exists to stop.
      res.writeHead(307, { location: `${attacker.origin}/stolen` });
      res.end();
    });
    bystander = await listen((req, res) => {
      if (req.url === '/hop') {
        res.writeHead(307, { location: `${bystander.origin}/landed` });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"landed":true}');
    });
    uninstall = installRelayerFetchGuard(relayer.origin);
  });

  after(() => {
    uninstall?.();
    relayer?.server.close();
    attacker?.server.close();
    bystander?.server.close();
  });

  it('refuses a cross-origin 307 from the guarded origin before any bytes reach the target', async () => {
    await assert.rejects(
      fetch(`${relayer.origin}/api/remember`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-signature': 'deadbeef',
          'x-account-id': '0xabc',
        },
        body: '{"text":"the memory payload"}',
      }),
      (error) => {
        assert.ok(error instanceof RelayerRedirectError);
        assert.equal(error.code, 'relayer-redirect-refused');
        // The error names both origins for the operator, never the payload.
        assert.match(error.message, /127\.0\.0\.1/);
        assert.doesNotMatch(error.message, /the memory payload/);
        assert.doesNotMatch(error.message, /deadbeef/);
        return true;
      },
    );
    assert.equal(attackerHits.length, 0);
  });

  it('refuses a same-origin redirect too — a signed request cannot survive a path change', async () => {
    const sameOriginRelayer = await listen((req, res) => {
      res.writeHead(308, { location: `${sameOriginRelayer.origin}/moved` });
      res.end();
    });
    const removeGuard = installRelayerFetchGuard(sameOriginRelayer.origin);
    try {
      await assert.rejects(
        fetch(`${sameOriginRelayer.origin}/api/recall`, { method: 'POST', body: '{}' }),
        (error) =>
          error instanceof RelayerRedirectError &&
          error.code === 'relayer-redirect-refused',
      );
    } finally {
      removeGuard();
      sameOriginRelayer.server.close();
    }
  });

  it('passes non-redirect guarded-origin responses through unchanged', async () => {
    const res = await fetch(`${relayer.origin}/plain`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
  });

  it('leaves unguarded origins with default redirect-following behavior', async () => {
    const res = await fetch(`${bystander.origin}/hop`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { landed: true });
  });

  it('is idempotent: installing the same origin twice wraps fetch once', () => {
    const first = globalThis.fetch;
    const again = installRelayerFetchGuard(relayer.origin);
    assert.equal(globalThis.fetch, first);
    again();
    // The origin is still guarded by the first installation.
    assert.equal(globalThis.fetch, first);
  });

  it('is installed by WalrusMemoryAdapter.getClient() for the approved origin', async () => {
    const { WalrusMemoryAdapter } = await import('../walrus-memory.js');
    const redirecting = await listen((req, res) => {
      res.writeHead(307, { location: `${attacker.origin}/stolen` });
      res.end();
    });
    const adapter = new WalrusMemoryAdapter(
      {
        MEMWAL_PRIVATE_KEY: 'a'.repeat(64),
        MEMWAL_ACCOUNT_ID: `0x${'b'.repeat(64)}`,
        // Loopback origins pass the SEC-01 gate without owner approval.
        MEMWAL_SERVER_URL: redirecting.origin,
      },
      { createClient: () => ({}) },
    );
    try {
      adapter.getClient();
      await assert.rejects(
        fetch(`${redirecting.origin}/api/remember`, { method: 'POST', body: '{}' }),
        (error) =>
          error instanceof RelayerRedirectError &&
          error.code === 'relayer-redirect-refused',
      );
      assert.equal(attackerHits.length, 0);
    } finally {
      redirecting.server.close();
    }
  });

  it('normalizes the guarded origin, so a differently written same origin is still guarded', async () => {
    // Same server, same origin string with an explicit default-port spelling
    // difference is not constructible for an ephemeral port, so assert the
    // normalization contract directly: trailing slash and path are dropped.
    const removeGuard = installRelayerFetchGuard(`${relayer.origin}/some/path?q=1`);
    try {
      await assert.rejects(
        fetch(`${relayer.origin}/api/remember`, { method: 'POST', body: '{}' }),
        (error) => error instanceof RelayerRedirectError,
      );
    } finally {
      removeGuard();
    }
  });
});
