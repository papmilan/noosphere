// One shared acceptance-client contract, implemented by two genuinely
// independent transports:
//   - sdkAdapter    → official @modelcontextprotocol/sdk Client
//   - rawAdapter    → hand-rolled JSON-RPC over Streamable HTTP (no SDK)
// Both expose: kind, connect(), listTools(), callTool(name,args),
// get/set sessionId, close(). The raw adapter additionally exposes `.raw` for
// low-level transport inspection.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { RawJsonRpcClient } from './raw-client.js';

export function sdkAdapter({ mcpUrl, token, origin = 'https://app.example' }) {
  let client;
  let transport;
  return {
    kind: 'sdk-client',
    async connect() {
      transport = new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${token}`, Origin: origin } } });
      client = new Client({ name: 'sdk-client', version: '0.0.0' }, { capabilities: {} });
      await client.connect(transport);
      return { serverInfo: client.getServerVersion() ?? null, capabilities: client.getServerCapabilities() ?? null };
    },
    async listTools() { return (await client.listTools()).tools; },
    async callTool(name, args) { return client.callTool({ name, arguments: args }); },
    get sessionId() { return transport ? transport.sessionId : undefined; },
    set sessionId(_v) { throw new Error('sdk-adapter-session-override-unsupported'); },
    async close() { if (transport) await transport.close(); },
  };
}

export function rawAdapter({ mcpUrl, token, origin = 'https://app.example' }) {
  const raw = new RawJsonRpcClient({ url: mcpUrl, token, origin });
  return {
    kind: 'raw-jsonrpc-client',
    raw,
    async connect() {
      const init = await raw.initialize();
      return { serverInfo: init.result ? init.result.serverInfo : null, capabilities: init.result ? init.result.capabilities : null, protocolVersion: init.result ? init.result.protocolVersion : null };
    },
    async listTools() { return raw.listTools(); },
    async callTool(name, args) { return raw.callTool(name, args); },
    get sessionId() { return raw.sessionId; },
    set sessionId(v) { raw.sessionId = v; },
    async close() { await raw.close(); },
  };
}

export const ADAPTERS = [sdkAdapter, rawAdapter];
export const structured = (result) => result.structuredContent;
