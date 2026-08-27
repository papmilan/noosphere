import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { InMemoryProjectMemoryRepository } from '@noosphere/remote-mcp-contracts/index.js';
import { startServer } from './harness.js';

const ACCEPT = 'application/json, text/event-stream';

async function postMcp(h, token, body, sessionId) {
  const headers = {
    accept: ACCEPT,
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  return fetch(h.mcpUrl, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function initialize(h, token, id = 1) {
  const response = await postMcp(h, token, {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'session-lifecycle-test', version: '0.0.0' },
    },
  });
  const sessionId = response.headers.get('mcp-session-id');
  if (response.status === 200 && sessionId) {
    await postMcp(h, token, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }, sessionId);
  }
  return { response, sessionId };
}

async function connect(h, token) {
  const transport = new StreamableHTTPClientTransport(new URL(h.mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'cursor-restart-test', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

describe('bounded MCP transport sessions', () => {
  it('expires idle sessions on the configured inactivity boundary while activity refreshes the lease', async () => {
    let time = 0;
    const h = await startServer({
      mcpSessionTtlMs: 1_000,
      deps: { sessionNow: () => time },
    });
    try {
      const token = await h.token({ sub: 'ttl-owner' });
      const { response, sessionId } = await initialize(h, token);
      assert.equal(response.status, 200);
      assert.ok(sessionId);
      assert.equal(h.server.sessions.size, 1);

      time = 999;
      assert.equal((await postMcp(h, token, {
        jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
      }, sessionId)).status, 200);

      time = 1_998;
      assert.equal((await postMcp(h, token, {
        jsonrpc: '2.0', id: 3, method: 'tools/list', params: {},
      }, sessionId)).status, 200);

      time = 2_998;
      const expired = await postMcp(h, token, {
        jsonrpc: '2.0', id: 4, method: 'tools/list', params: {},
      }, sessionId);
      assert.equal(expired.status, 404);
      assert.deepEqual(await expired.json(), { error: 'unknown-session' });
      assert.equal(h.server.sessions.size, 0);
    } finally {
      await h.close();
    }
  });

  it('refuses a new session when the configured global capacity is occupied', async () => {
    const h = await startServer({ maxMcpSessions: 1 });
    try {
      const token = await h.token({ sub: 'capacity-owner' });
      const first = await initialize(h, token, 1);
      assert.equal(first.response.status, 200);
      assert.ok(first.sessionId);
      assert.equal(h.server.sessions.size, 1);

      const second = await initialize(h, token, 2);
      assert.equal(second.response.status, 503);
      assert.deepEqual(await second.response.json(), { error: 'session-capacity' });
      assert.equal(second.response.headers.get('retry-after'), '1');
      assert.equal(h.server.sessions.size, 1);
    } finally {
      await h.close();
    }
  });
});

describe('cursor key lifecycle', () => {
  it('accepts a cursor after restart when replicas share the configured cursor secret', async () => {
    const repository = new InMemoryProjectMemoryRepository();
    const cursorSecret = 'restart-stable-cursor-secret-00000001';
    let cursor;

    const firstServer = await startServer({ repository, cursorSecret });
    try {
      const { client, transport } = await connect(firstServer, await firstServer.token({ sub: 'cursor-owner' }));
      await client.callTool({ name: 'create_project', arguments: { name: 'Project One' } });
      await client.callTool({ name: 'create_project', arguments: { name: 'Project Two' } });
      const firstPage = await client.callTool({ name: 'list_projects', arguments: { limit: 1 } });
      cursor = firstPage.structuredContent.next_cursor;
      assert.ok(cursor);
      await transport.close();
    } finally {
      await firstServer.close();
    }

    const restarted = await startServer({ repository, cursorSecret });
    try {
      const { client, transport } = await connect(restarted, await restarted.token({ sub: 'cursor-owner' }));
      const secondPage = await client.callTool({ name: 'list_projects', arguments: { limit: 1, cursor } });
      assert.equal(secondPage.isError, undefined);
      assert.equal(secondPage.structuredContent.projects.length, 1);
      await transport.close();
    } finally {
      await restarted.close();
    }
  });
});
