import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { buildServerOptions } from '../src/main.js';
import { createMcpServer } from '../src/server.js';

// A pg-Pool stand-in whose `select 1` behavior the test drives at will.
function fakePool(queryImpl) {
  const pool = new EventEmitter();
  pool.query = queryImpl;
  pool.end = async () => {};
  return pool;
}

const PROD_OPTIONS = Object.freeze({
  port: 0,
  audience: 'https://noosphere.example/pm',
  resourceMetadataUrl: 'https://noosphere.example/.well-known/oauth-protected-resource',
  authorizationServers: ['https://issuer.example/'],
  allowedOrigins: [],
  requiredScopes: [],
  production: true,
  repository: 'postgres',
  projectsPerOwner: null,
  logMode: 'json',
  cursorSecret: 'production-test-cursor-secret-00000001',
  issuers: [{ iss: 'https://issuer.example/', jwksUri: 'https://issuer.example/jwks' }],
  databaseUrl: 'postgres://u:p@db:5432/n',
});

async function status(baseUrl, path) {
  const res = await fetch(`${baseUrl}${path}`);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function withServer(queryImpl, run, { readinessTimeoutMs = 60 } = {}) {
  const logs = [];
  const logger = (line) => logs.push(line);
  const pool = fakePool(queryImpl);
  const built = buildServerOptions(PROD_OPTIONS, { logger, createPool: () => pool, readinessTimeoutMs });
  const server = createMcpServer({ ...built, logger });
  const address = await server.listen(0);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run({ baseUrl, logs, pool });
  } finally {
    await server.shutdown();
  }
}

test('a hung readiness query times out to 503 while /healthz stays 200, then recovers', async () => {
  let healthy = true;
  let dropHung = null; // rejects the pending hung query, as a dropped connection does
  const query = () => {
    if (healthy) return Promise.resolve({ rows: [{ '?column?': 1 }] });
    return new Promise((_, reject) => { dropHung = () => reject(new Error('connection terminated')); });
  };
  await withServer(query, async ({ baseUrl, logs }) => {
    // Healthy baseline.
    assert.equal((await status(baseUrl, '/readyz')).status, 200);

    // Database hangs: /readyz must degrade within the timeout, liveness unaffected.
    healthy = false;
    const started = Date.now();
    const ready = await status(baseUrl, '/readyz');
    const elapsed = Date.now() - started;
    assert.equal(ready.status, 503);
    assert.equal(ready.body.status, 'unavailable');
    assert.ok(elapsed < 2000, `readyz should time out fast, took ${elapsed}ms`);
    assert.equal((await status(baseUrl, '/healthz')).status, 200);
    assert.ok(logs.find((l) => l && l.event === 'readiness-timeout'), 'expected a readiness-timeout log');

    // The stalled connection drops (a real hung pooled client eventually errors),
    // settling the single in-flight query and clearing the guard; the database is
    // healthy again, so the next probe runs a fresh query and recovers to 200.
    healthy = true;
    dropHung();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal((await status(baseUrl, '/readyz')).status, 200);
  }, { readinessTimeoutMs: 40 });
});

test('a refused connection is 503, not a timeout', async () => {
  const query = async () => { throw new Error('ECONNREFUSED'); };
  await withServer(query, async ({ baseUrl, logs }) => {
    assert.equal((await status(baseUrl, '/readyz')).status, 503);
    // Refusal is fast and distinct from the hung-timeout path.
    assert.equal(logs.filter((l) => l && l.event === 'readiness-timeout').length, 0);
  });
});

test('a query that rejects after the timeout produces no unhandled rejection', async () => {
  const rejections = [];
  const onRejection = (err) => rejections.push(err);
  process.on('unhandledRejection', onRejection);
  try {
    // Rejects well after the 60ms readiness timeout: the race resolves to a
    // timeout first, and the late rejection must be absorbed, not thrown.
    const query = () => new Promise((_, reject) => setTimeout(() => reject(new Error('late failure')), 120));
    await withServer(query, async ({ baseUrl }) => {
      assert.equal((await status(baseUrl, '/readyz')).status, 503);
      // Wait past the rejection point so a leak would surface.
      await new Promise((r) => setTimeout(r, 200));
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(rejections, [], 'no unhandled rejection expected');
  } finally {
    process.removeListener('unhandledRejection', onRejection);
  }
});

// The critical boundedness guarantee: an application-level Promise.race does NOT
// cancel the underlying pg query, so the guard must stay occupied until that
// query settles — otherwise every timed-out probe would launch another query and
// a sustained hang would exhaust the pool. This test fails if the guard is
// released at timeout (it would see calls climb with each probe).
test('bounded concurrency: a sustained hang uses exactly ONE underlying query until it settles, then recovers', async () => {
  let calls = 0;
  let hung = true;
  let release = null; // resolves the single currently-held query
  const query = () => {
    calls += 1;
    if (!hung) return Promise.resolve({ rows: [{ '?column?': 1 }] });
    return new Promise((resolve) => { release = () => resolve({ rows: [{ '?column?': 1 }] }); });
  };

  const rejections = [];
  const onRejection = (err) => rejections.push(err);
  process.on('unhandledRejection', onRejection);
  const baselineListeners = process.listenerCount('unhandledRejection');
  try {
    await withServer(query, async ({ baseUrl }) => {
      // First probe: hung query -> 503 after timeout, one query started.
      assert.equal((await status(baseUrl, '/readyz')).status, 503);
      assert.equal(calls, 1, 'first probe starts exactly one query');

      // Many more probes, serial AND concurrent, while that query is still
      // pending: none may start an additional underlying query.
      for (let i = 0; i < 8; i += 1) {
        assert.equal((await status(baseUrl, '/readyz')).status, 503);
      }
      const concurrentResults = await Promise.all(Array.from({ length: 6 }, () => status(baseUrl, '/readyz')));
      assert.ok(concurrentResults.every((r) => r.status === 503), 'concurrent probes during a hang must all be 503');
      assert.equal(calls, 1, `exactly one underlying query during the hang, saw ${calls}`);
      assert.equal((await status(baseUrl, '/healthz')).status, 200);

      // Settle the original query; the guard clears.
      hung = false;
      release();
      await new Promise((r) => setTimeout(r, 20));

      // Only now may a fresh query run, and readiness recovers.
      assert.equal((await status(baseUrl, '/readyz')).status, 200);
      assert.equal(calls, 2, `a new query runs only after the first settled, saw ${calls}`);
    }, { readinessTimeoutMs: 40 });

    // No unhandled rejection, no listener growth from the readiness machinery.
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(rejections, [], 'no unhandled rejection');
    assert.equal(process.listenerCount('unhandledRejection'), baselineListeners);
  } finally {
    process.removeListener('unhandledRejection', onRejection);
  }
});
