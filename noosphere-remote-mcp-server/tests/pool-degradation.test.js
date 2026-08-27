import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { buildServerOptions } from '../src/main.js';
import { createMcpServer } from '../src/server.js';

// A stand-in for a pg Pool. Node's EventEmitter shares pg's fatal contract:
// emit('error') with no listener throws an uncaught exception (which, in
// production, crashes the process). So proving emit('error') does NOT throw here
// proves the composition root attached a handler and the process survives.
function fakePool({ query }) {
  const pool = new EventEmitter();
  pool.query = query;
  pool.end = async () => {};
  return pool;
}

const PROD_OPTIONS = {
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
};

async function get(baseUrl, path) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json() };
}

test('an idle Pool error is logged, does not crash, and readiness degrades while health stays alive', async () => {
  const logs = [];
  const logger = (line) => logs.push(line);

  // Database is reachable at first: `select 1` resolves.
  let dbHealthy = true;
  const pool = fakePool({
    query: async () => {
      if (!dbHealthy) throw new Error('connection terminated');
      return { rows: [{ '?column?': 1 }] };
    },
  });

  const built = buildServerOptions(PROD_OPTIONS, { logger, createPool: () => pool });
  const server = createMcpServer({ ...built, logger });
  const address = await server.listen(0);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // Healthy baseline.
    assert.equal((await get(baseUrl, '/healthz')).status, 200);
    assert.equal((await get(baseUrl, '/readyz')).status, 200);

    // An idle pooled client fails. Without the handler this throws (process
    // crash); with it, it is a no-op to the caller.
    assert.doesNotThrow(() => pool.emit('error', new Error('idle client failure')));

    // The error was logged via the injected logger, not swallowed.
    const poolError = logs.find((l) => l && l.event === 'pool-error');
    assert.ok(poolError, 'expected a pool-error log line');
    assert.match(poolError.message, /idle client failure/);

    // Database now down: readiness degrades to 503, liveness stays 200.
    dbHealthy = false;
    assert.equal((await get(baseUrl, '/healthz')).status, 200);
    const ready = await get(baseUrl, '/readyz');
    assert.equal(ready.status, 503);
    assert.equal(ready.body.status, 'unavailable');

    // Database recovers: readiness returns to 200 with no restart.
    dbHealthy = true;
    assert.equal((await get(baseUrl, '/readyz')).status, 200);
  } finally {
    await server.shutdown();
  }
});
