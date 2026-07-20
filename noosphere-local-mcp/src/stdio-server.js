import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { InMemoryProjectMemoryRepository, ProjectMemoryService } from '@noosphere/remote-mcp-contracts/index.js';
import { buildProjectMemoryMcpServer } from '@noosphere/remote-mcp-server/src/mcp-core.js';

import { LocalOwnerIdentity } from './local-identity.js';

// Server identity advertised to the MCP host over STDIO. The name differs from
// the remote server's (an instance label), but the tool surface, dispatch,
// envelopes, and error mapping are the shared core — see buildProjectMemoryMcpServer.
export const LOCAL_SERVER_INFO = Object.freeze({ name: 'noosphere-local-project-memory', version: '0.0.0' });

// Construct a Local STDIO MCP server that shares the exact Project Memory core
// and tool surface as the Remote HTTP server. The ONLY difference is the
// transport: one StdioServerTransport bound to one fixed local owner — no HTTP,
// no OIDC, no sessions. For PR7 the backend is the in-memory repository.
export function createLocalStdioServer({ repository, now, identity = new LocalOwnerIdentity(), stdin, stdout } = {}) {
  const repo = repository ?? new InMemoryProjectMemoryRepository();
  const service = new ProjectMemoryService({ repository: repo, now });
  const mcp = buildProjectMemoryMcpServer({ service, ownerScope: identity.ownerScope, serverInfo: LOCAL_SERVER_INFO });
  const transport = new StdioServerTransport(stdin, stdout);

  let started = false;
  let closing = false;

  return {
    repository: repo,
    ownerScope: identity.ownerScope,
    // Begin serving: connect the MCP server to STDIO, which starts reading
    // stdin and writing stdout. Resolves once the transport is live.
    async start() {
      if (started) return;
      started = true;
      await mcp.connect(transport);
    },
    // Graceful shutdown: closing the MCP server closes the STDIO transport,
    // which removes the stdin data listener and stops writing stdout. No timers
    // or extra handles are held open, so the event loop can drain and exit.
    async shutdown() {
      if (closing) return;
      closing = true;
      await mcp.close();
    },
  };
}
