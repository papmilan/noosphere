import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { describe, it } from 'node:test';

import { InMemoryProjectMemoryRepository } from '@noosphere/remote-mcp-contracts/index.js';

import { loadConfig } from '../src/config.js';
import { createMcpServer } from '../src/server.js';
import { startServer } from './harness.js';

function rawRequest(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const chunks = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('raw request did not receive a response'));
    }, 2_000);
    socket.on('connect', () => socket.end(request));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function bareServer(deps = {}) {
  const config = loadConfig({
    audience: 'https://noosphere.example/project-memory',
    issuers: { 'https://issuer.example/': 'configured' },
    resourceMetadataUrl: 'https://noosphere.example/.well-known/oauth-protected-resource',
  });
  return createMcpServer({
    config,
    verifier: { verify: async () => ({ ownerScope: 'owner:test' }) },
    repository: new InMemoryProjectMemoryRepository(),
    ...deps,
  });
}

describe('HTTP server failure boundaries', () => {
  it('answers a malformed Host header with 400 and remains healthy', async () => {
    const h = await startServer();
    try {
      const port = Number(new URL(h.baseUrl).port);
      const response = await rawRequest(
        port,
        'GET /healthz HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n',
      );
      assert.match(response, /^HTTP\/1\.1 400 /);
      assert.match(response, /invalid-request-url/);
      assert.equal((await fetch(`${h.baseUrl}/healthz`)).status, 200);
    } finally {
      await h.close();
    }
  });

  it('rejects listen when the port is already occupied instead of emitting an unhandled error', async () => {
    const occupied = http.createServer((_request, response) => response.end());
    await new Promise((resolve) => occupied.listen(0, resolve));
    const server = bareServer();
    try {
      await assert.rejects(
        server.listen(occupied.address().port),
        (error) => error?.code === 'EADDRINUSE',
      );
    } finally {
      await server.shutdown();
      await new Promise((resolve) => occupied.close(resolve));
    }
  });

  it('makes concurrent shutdown callers await the same cleanup', async () => {
    let enterCleanup;
    const cleanupEntered = new Promise((resolve) => { enterCleanup = resolve; });
    let releaseCleanup;
    const cleanupReleased = new Promise((resolve) => { releaseCleanup = resolve; });
    const server = bareServer({
      onShutdown: async () => {
        enterCleanup();
        await cleanupReleased;
      },
    });
    await server.listen(0);

    const first = server.shutdown();
    await cleanupEntered;
    let secondFinished = false;
    const second = server.shutdown().then(() => { secondFinished = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(secondFinished, false);

    releaseCleanup();
    await Promise.all([first, second]);
    assert.equal(secondFinished, true);
  });

  it('bounds shutdown when an authenticated client stalls mid-body', async () => {
    const server = bareServer({ shutdownGraceMs: 25 });
    const address = await server.listen(0);
    const socket = net.createConnection({ host: '127.0.0.1', port: address.port });
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.write([
      'POST /mcp HTTP/1.1',
      'Host: 127.0.0.1',
      'Authorization: Bearer test',
      'Content-Type: application/json',
      'Content-Length: 1000',
      '',
      '{',
    ].join('\r\n'));
    await new Promise((resolve) => setTimeout(resolve, 10));

    const shutdown = server.shutdown();
    const outcome = await Promise.race([
      shutdown.then(() => 'closed'),
      new Promise((resolve) => setTimeout(() => resolve('timed-out'), 250)),
    ]);
    socket.destroy();
    await shutdown;
    assert.equal(outcome, 'closed');
  });
});
