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
  } = raw;

  if (typeof audience !== 'string' || audience.length === 0) throw new Error('config-requires-audience');
  if (!issuers || typeof issuers !== 'object' || Object.keys(issuers).length === 0) throw new Error('config-requires-issuers');
  if (production && allowTestIdentities) throw new Error('production-forbids-test-identities');
  if (typeof resourceMetadataUrl !== 'string' || resourceMetadataUrl.length === 0) throw new Error('config-requires-resource-metadata-url');

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
