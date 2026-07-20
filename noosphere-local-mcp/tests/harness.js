import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SignJWT, generateKeyPair } from 'jose';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { InMemoryProjectMemoryRepository } from '@noosphere/remote-mcp-contracts/index.js';
// The remote server + PR3 OIDC verifier are consumed as merged sibling source,
// so the parity suite drives the REAL Streamable HTTP server, not a stub.
import { OidcVerifier } from '../../noosphere-remote-mcp-postgres/src/oidc.js';
import { loadConfig } from '../../noosphere-remote-mcp-server/src/config.js';
import { createMcpServer } from '../../noosphere-remote-mcp-server/src/server.js';

const ISS = 'https://issuer.example/';
const AUD = 'https://noosphere.example/project-memory';
const BIN = path.resolve(fileURLToPath(new URL('../bin/noosphere-local-mcp.js', import.meta.url)));
// Test-only launcher: the production CLI, but with a fixed clock injected via the
// existing `now` seam. Used for deterministic parity; never shipped.
const FIXED_CLOCK_LAUNCHER = path.resolve(fileURLToPath(new URL('./fixtures/stdio-fixed-clock.js', import.meta.url)));

export const structured = (result) => result.structuredContent;

export function clock(startIso = '2026-07-20T10:00:00.000Z') {
  let current = startIso;
  const now = () => current;
  now.set = (iso) => { current = iso; };
  return now;
}

// A real Remote HTTP client: starts the Streamable HTTP server (ephemeral port,
// in-memory repo, RS256 verifier with local keys) and an SDK client bound to a
// single verified owner. Mirrors the Local STDIO single-owner world so the two
// transports can be compared directly.
export async function startHttpClient({ now } = {}) {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const verifier = new OidcVerifier({ issuers: { [ISS]: publicKey }, audience: AUD, requiredScopes: [] });
  const config = loadConfig({
    audience: AUD,
    issuers: { [ISS]: 'configured' },
    authorizationServers: [ISS],
    allowedOrigins: ['https://app.example'],
    resourceMetadataUrl: 'https://noosphere.example/.well-known/oauth-protected-resource',
  });
  const server = createMcpServer({ config, verifier, repository: new InMemoryProjectMemoryRepository(), now });
  const address = await server.listen(0);
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const token = await new SignJWT({ scope: 'project.read project.write' })
    .setProtectedHeader({ alg: 'RS256' }).setIssuer(ISS).setAudience(AUD).setSubject('parity-owner').setIssuedAt().setExpirationTime('2h').sign(privateKey);
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  const client = new Client({ name: 'http-client', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return {
    kind: 'http',
    client,
    async close() { await transport.close(); await server.shutdown(); },
  };
}

// A real Local STDIO client: spawns the bin as a child process (the exact way an
// MCP host launches it) and connects an SDK client over stdio. Nothing is stubbed
// — this exercises the published CLI entry point.
export async function startStdioClient({ nowIso } = {}) {
  // A fixed instant → the test-only fixed-clock launcher (deterministic parity);
  // otherwise the real production CLI, exercised as an MCP host would.
  const args = nowIso ? [FIXED_CLOCK_LAUNCHER, nowIso] : [BIN];
  const transport = new StdioClientTransport({ command: process.execPath, args });
  const client = new Client({ name: 'stdio-client', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return {
    kind: 'stdio',
    client,
    transport,
    async close() { await transport.close(); },
  };
}

// Spawn the bin directly (no client) for shutdown / handle-leak inspection.
export function spawnBin() {
  return spawn(process.execPath, [BIN], { stdio: ['pipe', 'pipe', 'pipe'] });
}
