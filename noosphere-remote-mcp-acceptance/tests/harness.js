import { SignJWT, generateKeyPair } from 'jose';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { InMemoryProjectMemoryRepository } from '@noosphere/remote-mcp-contracts/index.js';
// Server + PR3 OIDC verifier consumed as merged sibling source (CI installs
// those siblings); the acceptance package adds no runtime code of its own.
import { OidcVerifier } from '../../noosphere-remote-mcp-postgres/src/oidc.js';
import { loadConfig } from '../../noosphere-remote-mcp-server/src/config.js';
import { createMcpServer } from '../../noosphere-remote-mcp-server/src/server.js';

export const ISS = 'https://issuer.example/';
export const AUD = 'https://noosphere.example/project-memory';
export const structured = (result) => result.structuredContent;

// A controllable clock: the service stamps project/session updated_at with it,
// so freshness assertions are deterministic instead of wall-clock dependent.
export function clock(startIso = '2026-07-20T10:00:00.000Z') {
  let current = startIso;
  const now = () => current;
  now.set = (iso) => { current = iso; };
  return now;
}

// Start the real PR4 server on an ephemeral port with an in-memory repository
// and a verifier backed by locally generated keys. No Git repo, no local
// folder, no CLI, and no user-run MCP process are involved — the only client is
// a network MCP client.
export async function startAcceptance({ now } = {}) {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const verifier = new OidcVerifier({ issuers: { [ISS]: publicKey }, audience: AUD, requiredScopes: [] });
  const config = loadConfig({
    audience: AUD,
    issuers: { [ISS]: 'configured' },
    authorizationServers: [ISS],
    allowedOrigins: ['https://app.example'],
    resourceMetadataUrl: 'https://noosphere.example/.well-known/oauth-protected-resource',
  });
  const repository = new InMemoryProjectMemoryRepository();
  const server = createMcpServer({ config, verifier, repository, now });
  const address = await server.listen(0);
  const mcpUrl = `http://127.0.0.1:${address.port}/mcp`;

  async function token({ sub = 'alice', iss = ISS, aud = AUD, exp = '2h' } = {}) {
    return new SignJWT({ scope: 'project.read project.write' })
      .setProtectedHeader({ alg: 'RS256' }).setIssuer(iss).setAudience(aud).setSubject(sub).setIssuedAt().setExpirationTime(exp).sign(privateKey);
  }

  // Connect a fresh MCP protocol client bound to one bearer identity, standing
  // in for a real client app (ChatGPT / Claude) at the protocol level.
  async function connect(tok, clientName = 'acceptance-client') {
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${tok}` } } });
    const client = new Client({ name: clientName, version: '0.0.0' }, { capabilities: {} });
    await client.connect(transport);
    return { client, transport, call: (name, args) => client.callTool({ name, arguments: args }), async close() { await transport.close(); } };
  }

  // Derive the same owner scope the verifier assigns to a subject, so scenarios
  // can seed prior state (e.g. an interrupted session left by an earlier client)
  // for the exact owner a token will resolve to.
  async function ownerScopeFor(sub) {
    return (await verifier.verify(await token({ sub }))).ownerScope;
  }

  return { server, mcpUrl, repository, token, connect, ownerScopeFor, async close() { await server.shutdown(); } };
}
