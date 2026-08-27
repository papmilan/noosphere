#!/usr/bin/env node
// Production entry point for the Noosphere Remote Project Memory HTTP server.
//
// This module is composition glue only: it reads deployment configuration from
// the environment and wires together the already-built factories
//   - loadConfig / createMcpServer        (this package)
//   - OidcVerifier / createPool /
//     PostgresProjectMemoryRepository      (noosphere-remote-mcp-postgres)
//   - InMemoryProjectMemoryRepository      (noosphere-remote-mcp-contracts)
// No existing module's behavior, tool schema, or business logic is changed
// here; deleting this file leaves the runtime exactly as it was.
//
// The two side-effect-free seams below (parseServerEnv, buildServerOptions) are
// exported so the env contract can be unit tested without binding a port or
// touching a database.

import { pathToFileURL } from 'node:url';

import { createRemoteJWKSet } from 'jose';

import { InMemoryProjectMemoryRepository } from '@noosphere/remote-mcp-contracts/index.js';
// Monorepo sibling-source imports: the PR3 OIDC verifier and PostgreSQL
// repository are consumed exactly as the test harness and CI jobs consume them
// (jose/pg resolve from that package's own node_modules).
import { OidcVerifier } from '../../noosphere-remote-mcp-postgres/src/oidc.js';
import { createPool } from '../../noosphere-remote-mcp-postgres/src/pool.js';
import { PostgresProjectMemoryRepository } from '../../noosphere-remote-mcp-postgres/src/repository.js';

import {
  MAX_MCP_SESSIONS_CEILING,
  MAX_MCP_SESSION_TTL_MS,
  isValidCursorSecret,
  loadConfig,
} from './config.js';
import { createMcpServer } from './server.js';

// Every NOOSPHERE_* environment variable the server understands. Any other
// key in that namespace is a typo or a stale/undocumented setting and is
// rejected at startup so a silent misconfiguration can never reach production.
export const KNOWN_ENV_KEYS = Object.freeze([
  'NOOSPHERE_PORT',
  'NOOSPHERE_AUDIENCE',
  'NOOSPHERE_RESOURCE_METADATA_URL',
  'NOOSPHERE_AUTHORIZATION_SERVERS',
  'NOOSPHERE_OIDC_ISSUERS',
  'NOOSPHERE_ALLOWED_ORIGINS',
  'NOOSPHERE_REQUIRED_SCOPES',
  'NOOSPHERE_MAX_BODY_BYTES',
  'NOOSPHERE_CURSOR_SECRET',
  'NOOSPHERE_MCP_SESSION_TTL_MS',
  'NOOSPHERE_MAX_MCP_SESSIONS',
  'NOOSPHERE_PRODUCTION',
  'NOOSPHERE_REPOSITORY',
  'NOOSPHERE_PROJECTS_PER_OWNER',
  'NOOSPHERE_LOG',
]);

function requireValue(env, key) {
  const value = env[key];
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`config-requires:${key}`);
  return value.trim();
}

function splitList(value) {
  if (typeof value !== 'string') return [];
  return value.split(/[\s,]+/).filter(Boolean);
}

function parseBool(value, fallback) {
  if (value === undefined) return fallback;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error('config-invalid-boolean');
}

// Parse a JSON array of issuer descriptors: [{ "iss": "...", "jwks_uri": "..." }].
// jwks_uri must be an absolute https URL; iss must be a non-empty string. No
// network access happens here — resolvers are built lazily in buildServerOptions.
function parseIssuers(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('config-invalid-oidc-issuers-json');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('config-requires-oidc-issuers');
  return parsed.map((entry) => {
    if (!entry || typeof entry.iss !== 'string' || entry.iss.length === 0) throw new Error('config-invalid-issuer');
    if (typeof entry.jwks_uri !== 'string' || entry.jwks_uri.length === 0) throw new Error('config-invalid-jwks-uri');
    let url;
    try {
      url = new URL(entry.jwks_uri);
    } catch {
      throw new Error('config-invalid-jwks-uri');
    }
    if (url.protocol !== 'https:') throw new Error('config-jwks-uri-requires-https');
    return { iss: entry.iss, jwksUri: entry.jwks_uri };
  });
}

// Pure: environment map -> validated plain option values. No jose, no pg, no
// network, no port binding. Rejects unknown NOOSPHERE_* keys and missing/invalid
// required values so misconfiguration fails loud and early.
export function parseServerEnv(env = process.env) {
  for (const key of Object.keys(env)) {
    if (key.startsWith('NOOSPHERE_') && !KNOWN_ENV_KEYS.includes(key)) {
      throw new Error(`config-unknown-env:${key}`);
    }
  }

  const production = parseBool(env.NOOSPHERE_PRODUCTION, false);
  const repository = env.NOOSPHERE_REPOSITORY ?? (production ? 'postgres' : 'memory');
  if (repository !== 'postgres' && repository !== 'memory') throw new Error('config-invalid-repository');
  // The in-memory repository is ephemeral single-node state; it must never back
  // a production deployment, only local smoke/health checks.
  if (production && repository === 'memory') throw new Error('production-requires-postgres-repository');

  // In production the RFC 9728 protected-resource metadata must advertise at
  // least one authorization server, or OAuth discovery is silently incomplete.
  const authorizationServers = splitList(env.NOOSPHERE_AUTHORIZATION_SERVERS);
  if (production && authorizationServers.length === 0) throw new Error('config-requires:NOOSPHERE_AUTHORIZATION_SERVERS');

  const port = env.NOOSPHERE_PORT === undefined ? 8080 : Number(env.NOOSPHERE_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('config-invalid-port');

  let maxBodyBytes;
  if (env.NOOSPHERE_MAX_BODY_BYTES !== undefined) {
    maxBodyBytes = Number(env.NOOSPHERE_MAX_BODY_BYTES);
    if (!Number.isInteger(maxBodyBytes) || maxBodyBytes <= 0) throw new Error('config-invalid-max-body-bytes');
  }

  let cursorSecret;
  if (env.NOOSPHERE_CURSOR_SECRET !== undefined) {
    cursorSecret = requireValue(env, 'NOOSPHERE_CURSOR_SECRET');
    if (!isValidCursorSecret(cursorSecret)) throw new Error('config-invalid-cursor-secret');
  } else if (production) {
    throw new Error('config-requires:NOOSPHERE_CURSOR_SECRET');
  }

  let mcpSessionTtlMs;
  if (env.NOOSPHERE_MCP_SESSION_TTL_MS !== undefined) {
    mcpSessionTtlMs = Number(env.NOOSPHERE_MCP_SESSION_TTL_MS);
    if (!Number.isInteger(mcpSessionTtlMs) || mcpSessionTtlMs <= 0 || mcpSessionTtlMs > MAX_MCP_SESSION_TTL_MS) {
      throw new Error('config-invalid-mcp-session-ttl-ms');
    }
  }

  let maxMcpSessions;
  if (env.NOOSPHERE_MAX_MCP_SESSIONS !== undefined) {
    maxMcpSessions = Number(env.NOOSPHERE_MAX_MCP_SESSIONS);
    if (!Number.isInteger(maxMcpSessions) || maxMcpSessions <= 0 || maxMcpSessions > MAX_MCP_SESSIONS_CEILING) {
      throw new Error('config-invalid-max-mcp-sessions');
    }
  }

  let projectsPerOwner = null;
  if (env.NOOSPHERE_PROJECTS_PER_OWNER !== undefined) {
    projectsPerOwner = Number(env.NOOSPHERE_PROJECTS_PER_OWNER);
    if (!Number.isInteger(projectsPerOwner) || projectsPerOwner <= 0) throw new Error('config-invalid-projects-per-owner');
  }

  const logMode = env.NOOSPHERE_LOG ?? 'json';
  if (logMode !== 'json' && logMode !== 'silent') throw new Error('config-invalid-log-mode');

  const options = {
    port,
    audience: requireValue(env, 'NOOSPHERE_AUDIENCE'),
    resourceMetadataUrl: requireValue(env, 'NOOSPHERE_RESOURCE_METADATA_URL'),
    authorizationServers,
    allowedOrigins: splitList(env.NOOSPHERE_ALLOWED_ORIGINS),
    requiredScopes: splitList(env.NOOSPHERE_REQUIRED_SCOPES),
    production,
    repository,
    projectsPerOwner,
    logMode,
    issuers: parseIssuers(requireValue(env, 'NOOSPHERE_OIDC_ISSUERS')),
    databaseUrl: repository === 'postgres' ? requireValue(env, 'DATABASE_URL') : env.DATABASE_URL,
  };
  if (maxBodyBytes !== undefined) options.maxBodyBytes = maxBodyBytes;
  if (cursorSecret !== undefined) options.cursorSecret = cursorSecret;
  if (mcpSessionTtlMs !== undefined) options.mcpSessionTtlMs = mcpSessionTtlMs;
  if (maxMcpSessions !== undefined) options.maxMcpSessions = maxMcpSessions;
  return options;
}

// Default upper bound on a single /readyz database probe. Conservative for a
// local, in-cluster health check: long enough to ride out a brief hiccup, short
// enough that a hung connection degrades to 503 well inside a typical 10s
// health-check timeout. Overridable only as a test seam, not user config.
export const READINESS_TIMEOUT_MS = 3000;

// Turn parsed options into the concrete collaborators createMcpServer needs.
// Builds lazy JWKS resolvers (no network yet), the OIDC verifier, the config,
// and either the PostgreSQL or in-memory repository plus a matching readiness
// probe and shutdown hook.
export function buildServerOptions(
  options,
  { logger = () => {}, createPool: makePool = createPool, readinessTimeoutMs = READINESS_TIMEOUT_MS } = {},
) {
  const verifierIssuers = {};
  const configIssuers = {};
  for (const { iss, jwksUri } of options.issuers) {
    verifierIssuers[iss] = createRemoteJWKSet(new URL(jwksUri));
    configIssuers[iss] = 'configured';
  }

  const verifier = new OidcVerifier({
    issuers: verifierIssuers,
    audience: options.audience,
    requiredScopes: options.requiredScopes,
    production: options.production,
  });

  const config = loadConfig({
    audience: options.audience,
    issuers: configIssuers,
    authorizationServers: options.authorizationServers,
    allowedOrigins: options.allowedOrigins,
    requiredScopes: options.requiredScopes,
    resourceMetadataUrl: options.resourceMetadataUrl,
    production: options.production,
    port: options.port,
    cursorSecret: options.cursorSecret,
    mcpSessionTtlMs: options.mcpSessionTtlMs,
    maxMcpSessions: options.maxMcpSessions,
    ...(options.maxBodyBytes !== undefined ? { maxBodyBytes: options.maxBodyBytes } : {}),
  });

  if (options.repository === 'memory') {
    return { config, verifier, repository: new InMemoryProjectMemoryRepository(), readinessCheck: async () => true, onShutdown: async () => {} };
  }

  const pool = makePool(options.databaseUrl);
  // A pg Pool emits 'error' when an *idle* pooled client fails (database
  // restart/failover, network drop). With no listener Node raises an uncaught
  // exception and the process crashes; that would defeat graceful degradation.
  // Log it and let readinessCheck report the degraded state — no retry, no
  // recovery, and never a silent swallow.
  pool.on('error', (error) => {
    logger({ event: 'pool-error', message: error && error.message ? error.message : String(error) });
  });
  const repository = new PostgresProjectMemoryRepository({
    pool,
    quota: options.projectsPerOwner !== null ? { projectsPerOwner: options.projectsPerOwner } : undefined,
  });
  // Readiness is true only when the control-plane database answers a trivial
  // query within readinessTimeoutMs. A hung connection (DB reachable at the TCP
  // level but not answering) must degrade /readyz to 503 without (a) blocking the
  // probe forever or (b) piling up queries against a stalled pool.
  //
  // The guard is the *underlying query*, not the probe: `pendingQuery` holds the
  // single in-flight `select 1` and is cleared only when that query itself
  // settles. Each call races that one shared query against its own timer. A
  // timed-out probe returns 503 but leaves the query in flight and starts NO new
  // query, so at most one `select 1` is ever outstanding, no matter how many
  // probes arrive during the hang (pg offers no mid-flight cancel, so bounding
  // the *count* is the correct guarantee). When the query finally settles the
  // guard clears and the next probe starts a fresh query, so readiness recovers.
  // The query is normalized with .then(ok, err) so a late settlement after a
  // timeout can never surface as an unhandled rejection, and every timer is
  // cleared on its own path.
  let pendingQuery = null;
  const readinessCheck = async () => {
    if (!pendingQuery) {
      const query = pool.query('select 1').then(() => 'ok', () => 'error');
      query.finally(() => { pendingQuery = null; });
      pendingQuery = query;
    }
    const current = pendingQuery;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), readinessTimeoutMs);
    });
    try {
      const outcome = await Promise.race([current, timeout]);
      if (outcome === 'timeout') logger({ event: 'readiness-timeout', timeoutMs: readinessTimeoutMs });
      return outcome === 'ok';
    } finally {
      clearTimeout(timer);
    }
  };
  return { config, verifier, repository, readinessCheck, onShutdown: async () => { await pool.end(); } };
}

export async function main({ env = process.env, log = console.log, errorLog = console.error } = {}) {
  const options = parseServerEnv(env);
  const logger = options.logMode === 'silent' ? () => {} : (line) => log(JSON.stringify(line));
  const server = createMcpServer({ ...buildServerOptions(options, { logger }), logger });

  const address = await server.listen(options.port);
  logger({ event: 'listening', port: address.port, repository: options.repository, production: options.production });

  let shuttingDown = false;
  const stop = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger({ event: 'shutdown', signal });
    try {
      await server.shutdown();
    } catch (error) {
      errorLog(`shutdown-error: ${error && error.message ? error.message : error}`);
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  return server;
}

// Boot only when executed directly (`node src/main.js`), never on import.
// pathToFileURL encodes the entry path the same way import.meta.url is encoded,
// so the comparison holds even when the path contains spaces.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`noosphere-remote-mcp-server failed to start: ${error && error.message ? error.message : error}`);
    process.exit(1);
  });
}
