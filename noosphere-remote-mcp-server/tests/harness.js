import { SignJWT, generateKeyPair } from 'jose';

import { InMemoryProjectMemoryRepository } from '../../noosphere-remote-mcp/index.js';
import { OidcVerifier } from '../../noosphere-remote-mcp-postgres/src/oidc.js';
import { loadConfig } from '../src/config.js';
import { createMcpServer } from '../src/server.js';

export const ISS = 'https://issuer.example/';
export const AUD = 'https://noosphere.example/project-memory';

// Spin up a real server on an ephemeral port with an in-memory repository and a
// verifier backed by locally generated keys. Returns helpers to mint tokens and
// build authenticated URLs.
export async function startServer(overrides = {}) {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const verifier = new OidcVerifier({ issuers: { [ISS]: publicKey }, audience: AUD, requiredScopes: [] });
  const config = loadConfig({
    audience: AUD,
    issuers: { [ISS]: 'configured' },
    authorizationServers: ['https://issuer.example/'],
    allowedOrigins: ['https://app.example'],
    resourceMetadataUrl: 'https://noosphere.example/.well-known/oauth-protected-resource',
    ...overrides,
  });
  const repository = overrides.repository ?? new InMemoryProjectMemoryRepository();
  const server = createMcpServer({ config, verifier, repository, ...overrides.deps });
  const address = await server.listen(0);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function token({ sub = 'alice', iss = ISS, aud = AUD, exp = '2h' } = {}) {
    return new SignJWT({ scope: 'project.read project.write' })
      .setProtectedHeader({ alg: 'RS256' }).setIssuer(iss).setAudience(aud).setSubject(sub).setIssuedAt().setExpirationTime(exp).sign(privateKey);
  }

  return { server, baseUrl, mcpUrl: `${baseUrl}/mcp`, token, repository, async close() { await server.shutdown(); } };
}
