#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const RELAYER_URL = (
  process.env.NOOSPHERE_RELAYER_URL || 'http://localhost:3001'
).replace(/\/+$/, '');
const SSE_PORT = parsePort(process.env.MCP_SSE_PORT || '3002');
const args = new Set(process.argv.slice(2));
const runStdio = args.has('--stdio') || (!args.has('--stdio') && !args.has('--sse'));
const runSse = args.has('--sse') || (!args.has('--stdio') && !args.has('--sse'));

function createAgentGenomeServer() {
  const server = new McpServer({
    name: 'noosphere',
    version: '0.1.0',
  }, {
    instructions:
      'At the start of every project session, call get_project_context with the current project_id before making changes. Store important decisions and completed work with store_action so the next agent can continue.',
  });

  server.registerTool(
    'get_project_context',
    {
      title: 'Get project context',
      description:
        'Get the full memory and history of a project. Call this at the start of every session to know what happened before.',
      inputSchema: {
        project_id: z.string().min(1).describe('Shared project identifier'),
      },
    },
    async ({ project_id }) => {
      const response = await relayerRequest(
        `/v1/projects/${encodeURIComponent(project_id)}/context?format=text`,
        {
          headers: { Accept: 'text/plain' },
        },
      );
      const context = await response.text();

      return {
        content: [{ type: 'text', text: context }],
      };
    },
  );

  server.registerTool(
    'store_action',
    {
      title: 'Store agent action',
      description:
        'Store an agent action or decision in shared project memory so other agents can see it.',
      inputSchema: {
        project_id: z.string().min(1),
        agent_id: z.string().min(1),
        action_type: z.enum(['code', 'decision', 'review', 'session']),
        content: z.string().min(1),
        genome_object_id: z.string().min(1),
      },
    },
    async (input) => {
      const sessionId = `mcp-${Date.now()}`;
      const response = await relayerRequest('/v1/actions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `${sessionId}-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          ...input,
          session_id: sessionId,
          client: 'MCP',
        }),
      });
      const result = await response.json();
      const output = {
        success: true,
        blob_id: result.blob_id,
        message: `Action stored in Noosphere. Transaction: ${result.tx_digest}`,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    'list_agents',
    {
      title: 'List project agents',
      description:
        'List all agents that have worked on this project and their current reputation scores.',
      inputSchema: {
        project_id: z.string().min(1).describe('Shared project identifier'),
      },
    },
    async ({ project_id }) => {
      const response = await relayerRequest(
        `/v1/projects/${encodeURIComponent(project_id)}/agents`,
      );
      const result = await response.json();
      const agents = result.agents || [];
      const lines =
        agents.length === 0
          ? [`No agents registered for project "${project_id}".`]
          : agents.map((agent) => {
              const identity = [
                agent.provider,
                agent.model,
                agent.client,
              ]
                .filter(Boolean)
                .join(' / ');
              return [
                `${agent.agent_name || 'Unnamed agent'}: reputation ${agent.reputation_score ?? 'unknown'}`,
                agent.average_rating === null ||
                agent.average_rating === undefined
                  ? 'no verified ratings'
                  : `average rating ${formatSigned(agent.average_rating)}/10 from ${agent.verified_rating_count} outputs`,
                `${agent.decision_count ?? 0} decisions`,
                agent.genome_object_id,
                identity,
              ]
                .filter(Boolean)
                .join(' | ');
            });

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    },
  );

  return server;
}

function formatSigned(value) {
  const number = Number(value);
  return `${number > 0 ? '+' : ''}${number.toFixed(1)}`;
}

async function relayerRequest(pathname, options = {}) {
  let response;
  try {
    response = await fetch(`${RELAYER_URL}${pathname}`, options);
  } catch (error) {
    throw new Error(
      `Noosphere relayer is unavailable at ${RELAYER_URL}: ${error.message}`,
    );
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Relayer request failed (${response.status}): ${body || response.statusText}`,
    );
  }

  return response;
}

async function startStdio() {
  const server = createAgentGenomeServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[noosphere-mcp] stdio ready; relayer=${RELAYER_URL}`,
  );
}

async function startSse() {
  const app = createMcpExpressApp();
  const transports = new Map();

  app.get('/health', (_req, res) => {
    res.json({
      success: true,
      transport: 'sse',
      relayer_url: RELAYER_URL,
    });
  });

  app.get('/sse', async (_req, res) => {
    const transport = new SSEServerTransport('/messages', res);
    const sessionId = transport.sessionId;
    transports.set(sessionId, transport);
    transport.onclose = () => transports.delete(sessionId);

    try {
      const server = createAgentGenomeServer();
      await server.connect(transport);
      console.error(
        `[noosphere-mcp] SSE client connected: ${sessionId}`,
      );
    } catch (error) {
      transports.delete(sessionId);
      console.error('[noosphere-mcp] SSE connection failed:', error);
      if (!res.headersSent) {
        res.status(500).send('Could not establish MCP SSE session');
      }
    }
  });

  app.post('/messages', async (req, res) => {
    const sessionId = String(req.query.sessionId || '');
    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(404).send('MCP SSE session not found');
      return;
    }

    try {
      await transport.handlePostMessage(req, res, req.body);
    } catch (error) {
      console.error('[noosphere-mcp] SSE message failed:', error);
      if (!res.headersSent) {
        res.status(500).send('Could not process MCP message');
      }
    }
  });

  const httpServer = app.listen(SSE_PORT, '127.0.0.1', () => {
    console.error(
      `[noosphere-mcp] SSE ready at http://127.0.0.1:${SSE_PORT}/sse`,
    );
  });

  httpServer.on('error', (error) => {
    if (error.code === 'EADDRINUSE' && runStdio) {
      console.error(
        `[noosphere-mcp] port ${SSE_PORT} already in use; stdio remains available`,
      );
      return;
    }
    throw error;
  });

  const shutdown = async () => {
    for (const transport of transports.values()) {
      await transport.close().catch(() => {});
    }
    httpServer.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('MCP_SSE_PORT must be an integer from 1 to 65535');
  }
  return port;
}

await Promise.all([
  runStdio ? startStdio() : Promise.resolve(),
  runSse ? startSse() : Promise.resolve(),
]);
