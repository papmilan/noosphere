import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { MCP_TOOLS } from '@noosphere/remote-mcp-contracts/index.js';

// MCP tool name -> ProjectMemoryService method. Only the 16 published tools.
export const TOOL_METHOD = Object.freeze({
  create_project: 'createProject', get_project: 'getProject', list_projects: 'listProjects',
  find_projects: 'findProjects', update_project: 'updateProject', archive_project: 'archiveProject',
  create_session: 'createSession', get_session: 'getSession', list_project_sessions: 'listProjectSessions',
  transition_session: 'transitionSession',
  save_checkpoint: 'saveCheckpoint', get_latest_checkpoint: 'getLatestCheckpoint', get_checkpoint: 'getCheckpoint',
  list_checkpoints: 'listCheckpoints', resume_project: 'resumeProject', get_project_summary: 'getProjectSummary',
});
// Bare single-entity returns are wrapped into the published MCP output envelope
// here at the transport boundary (discharges the PR2 wrapping follow-up).
export const WRAP_KEY = Object.freeze({ create_project: 'project', get_project: 'project', update_project: 'project', archive_project: 'project', create_session: 'session', get_session: 'session', transition_session: 'session' });

export function toolError(publicError) {
  return { isError: true, content: [{ type: 'text', text: publicError.error.code }], structuredContent: publicError };
}

// Build a transport-agnostic MCP Server bound to exactly one ownerScope. Both
// the Streamable HTTP server (multi-user, OIDC-derived scope) and the Local
// STDIO server (single-user, fixed local scope) call this, so the tool surface,
// dispatch, result envelopes, and error mapping are byte-for-byte identical.
// The transport wired around the returned Server is the only difference; the
// ownerScope is injected by the transport layer and is never read from tool
// input, so a caller cannot spoof identity through arguments.
export function buildProjectMemoryMcpServer({ service, ownerScope, serverInfo }) {
  if (!service) throw new Error('mcp-core-requires-service');
  if (typeof ownerScope !== 'string') throw new Error('mcp-core-requires-owner-scope');
  const server = new Server(serverInfo, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(MCP_TOOLS).map(([name, def]) => ({ name, description: `Project Memory ${name}`, inputSchema: def.input })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const method = TOOL_METHOD[name];
    if (!method) return toolError({ isError: true, error: { code: 'invalid-argument', retryable: false } });
    try {
      const result = await service[method]({ ownerScope, input: request.params.arguments ?? {} });
      const structured = WRAP_KEY[name] ? { [WRAP_KEY[name]]: result } : result;
      return { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured };
    } catch (error) {
      return toolError(error && error.isError && error.error ? error : { isError: true, error: { code: 'internal', retryable: false } });
    }
  });
  return server;
}
