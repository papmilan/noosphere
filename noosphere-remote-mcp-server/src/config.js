// Safe bounded default request-body limit (1 MiB) and the hard ceiling a
// configured override may not exceed (64 MiB). Bodies are buffered in memory,
// so an unbounded limit is a denial-of-service surface.
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const MAX_BODY_BYTES_CEILING = 64 * 1024 * 1024;

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
  } = raw;

  if (typeof audience !== 'string' || audience.length === 0) throw new Error('config-requires-audience');
  if (!issuers || typeof issuers !== 'object' || Object.keys(issuers).length === 0) throw new Error('config-requires-issuers');
  if (production && allowTestIdentities) throw new Error('production-forbids-test-identities');
  if (typeof resourceMetadataUrl !== 'string' || resourceMetadataUrl.length === 0) throw new Error('config-requires-resource-metadata-url');
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes <= 0 || maxBodyBytes > MAX_BODY_BYTES_CEILING) throw new Error('config-invalid-max-body-bytes');

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
