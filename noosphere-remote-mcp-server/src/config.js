// Safe bounded default request-body limit (1 MiB) and the hard ceiling a
// configured override may not exceed (64 MiB). Bodies are buffered in memory,
// so an unbounded limit is a denial-of-service surface.
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const MAX_BODY_BYTES_CEILING = 64 * 1024 * 1024;
export const DEFAULT_MCP_SESSION_TTL_MS = 30 * 60 * 1000;
export const MAX_MCP_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_MCP_SESSIONS = 1000;
export const MAX_MCP_SESSIONS_CEILING = 100_000;
export const MIN_CURSOR_SECRET_BYTES = 32;
const MAX_CURSOR_SECRET_BYTES = 4096;

export function isValidCursorSecret(value) {
  return typeof value === 'string'
    && Buffer.byteLength(value, 'utf8') >= MIN_CURSOR_SECRET_BYTES
    && Buffer.byteLength(value, 'utf8') <= MAX_CURSOR_SECRET_BYTES;
}

// Server configuration + validation. The resource server never trusts a
// production config that enables the development test-identity injector.
export function loadConfig(raw = {}) {
  const {
    audience,
    issuers,
    authorizationServers = [],
    allowedOrigins = [],
    requiredScopes = [],
    resourceMetadataUrl,
    production = false,
    allowTestIdentities = false,
    port = 0,
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
    cursorSecret,
    mcpSessionTtlMs = DEFAULT_MCP_SESSION_TTL_MS,
    maxMcpSessions = DEFAULT_MAX_MCP_SESSIONS,
  } = raw;

  if (typeof audience !== 'string' || audience.length === 0) throw new Error('config-requires-audience');
  if (!issuers || typeof issuers !== 'object' || Object.keys(issuers).length === 0) throw new Error('config-requires-issuers');
  if (production && allowTestIdentities) throw new Error('production-forbids-test-identities');
  if (typeof resourceMetadataUrl !== 'string' || resourceMetadataUrl.length === 0) throw new Error('config-requires-resource-metadata-url');
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes <= 0 || maxBodyBytes > MAX_BODY_BYTES_CEILING) throw new Error('config-invalid-max-body-bytes');
  if (production && cursorSecret === undefined) throw new Error('config-requires-cursor-secret');
  if (cursorSecret !== undefined && !isValidCursorSecret(cursorSecret)) throw new Error('config-invalid-cursor-secret');
  if (!Number.isInteger(mcpSessionTtlMs) || mcpSessionTtlMs <= 0 || mcpSessionTtlMs > MAX_MCP_SESSION_TTL_MS) throw new Error('config-invalid-mcp-session-ttl-ms');
  if (!Number.isInteger(maxMcpSessions) || maxMcpSessions <= 0 || maxMcpSessions > MAX_MCP_SESSIONS_CEILING) throw new Error('config-invalid-max-mcp-sessions');

  return Object.freeze({
    audience,
    issuers,
    authorizationServers: [...authorizationServers],
    allowedOrigins: new Set(allowedOrigins),
    requiredScopes: [...requiredScopes],
    resourceMetadataUrl,
    production,
    allowTestIdentities,
    port,
    maxBodyBytes,
    cursorSecret,
    mcpSessionTtlMs,
    maxMcpSessions,
  });
}

// RFC 9728 protected-resource metadata document.
export function protectedResourceMetadata(config) {
  return {
    resource: config.audience,
    authorization_servers: config.authorizationServers,
    scopes_supported: config.requiredScopes,
    bearer_methods_supported: ['header'],
  };
}
