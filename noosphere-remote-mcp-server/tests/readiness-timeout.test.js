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
  let mode = 'ok'; // ok | hang
  const query = async () => {
    if (mode === 'hang') return new Promise(() => {}); // never settles
    return { rows: [{ '?column?': 1 }] };
  };
  await withServer(query, async ({ baseUrl, logs }) => {
    // Healthy baseline.
    assert.equal((await status(baseUrl, '/readyz')).status, 200);

    // Database hangs: /readyz must degrade within the timeout, liveness unaffected.
    mode = 'hang';
    const started = Date.now();
    const ready = await status(baseUrl, '/readyz');
    const elapsed = Date.now() - started;
    assert.equal(ready.status, 503);
    assert.equal(ready.body.status, 'unavailable');
    assert.ok(elapsed < 2000, `readyz should time out fast, took ${elapsed}ms`);
    assert.equal((await status(baseUrl, '/healthz')).status, 200);
    assert.ok(logs.find((l) => l && l.event === 'readiness-timeout'), 'expected a readiness-timeout log');

    // Database recovers: readiness returns to 200 with no restart.
    mode = 'ok';
    assert.equal((await status(baseUrl, '/readyz')).status, 200);
  });
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

test('single-flight: concurrent probes against a hung DB collapse to one query', async () => {
  let calls = 0;
  const query = () => { calls += 1; return new Promise(() => {}); };
  await withServer(query, async ({ baseUrl }) => {
    // Fire several readiness probes concurrently while the DB hangs.
    const results = await Promise.all(Array.from({ length: 5 }, () => status(baseUrl, '/readyz')));
    for (const r of results) assert.equal(r.status, 503);
    // The single-flight guard means the overlapping probes shared one query
    // rather than opening five stalled queries.
    assert.equal(calls, 1, `expected 1 in-flight query, saw ${calls}`);
  });
});
