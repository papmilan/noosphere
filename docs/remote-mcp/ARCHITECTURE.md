# Remote Project Memory — Architecture overview

An operator-facing map of the Remote MCP deployment: the packages, the request
path, the trust boundaries, and where state lives. It describes the system as
built (PR1–PR5/PR7); this PR added no components and changed no behavior.

## Package layout

```
noosphere-remote-mcp            Contracts + Project Memory service core
  contracts/ core/ schemas/     Versioned tool schemas, validation, service
noosphere-remote-mcp-postgres   Control-plane adapter
  src/repository.js             PostgresProjectMemoryRepository (durable store)
  src/oidc.js                   OidcVerifier (OAuth 2.1 resource-server checks)
  src/pool.js                   pg Pool + transaction helper
  migrations/ migrate.js        Ordered, advisory-locked SQL migrations
noosphere-remote-mcp-server     Deployable HTTP server
  src/server.js                 Streamable HTTP transport, auth gate, sessions
  src/mcp-core.js               Shared tool builder (buildProjectMemoryMcpServer)
  src/config.js  src/logging.js Config validation, redacting structured logs
  src/main.js                   Production entrypoint (env -> compose -> listen)
noosphere-local-mcp             Local STDIO transport (single-user, in-memory)
```

The service core and tool surface are **shared** by both transports; only the
transport and identity model differ (see [`TRANSPORTS.md`](TRANSPORTS.md)).

## Request path (Remote HTTP)

```
Client ──HTTPS──> Reverse proxy ──HTTP──> Server (/mcp)
                                            │
                    1. Origin allowlist check (403 forbidden-origin)
                    2. Bearer verification via OidcVerifier (401)
                       └─ issuer + audience + signature + exp + scopes
                       └─ ownerScope = issuer:<iss>|subject:<sub>
                    3. Body-limit streaming guard (413) / JSON parse (400)
                    4. Session routing, owner-bound (404 / 403 mismatch)
                    5. MCP tool dispatch  ──> ProjectMemoryService
                                                └─> PostgresProjectMemoryRepository
                                                      └─> PostgreSQL
```

Health (`/healthz`), readiness (`/readyz`), and RFC 9728 metadata are served
before the auth gate and never touch tool logic.

## Trust boundaries

1. **Network edge** — TLS terminates at the reverse proxy. The Node process
   speaks plain HTTP only on the internal network and never terminates TLS.
2. **Authentication** — the OIDC verifier is the sole source of identity. Only
   asymmetric JWKS signatures are accepted (`alg=none` and `HS*` refused). No
   client-supplied owner/subject/token content is trusted; the owner scope is
   derived exclusively from verified claims.
3. **Authorization / isolation** — every repository operation is owner-scoped;
   one owner can never read or write another's projects. Sessions are pinned to
   the owner that created them.
4. **Data plane** — PostgreSQL sits on an internal-only network
   (`internal: true` in the compose reference), unreachable from the edge.

## State & durability

- **Server:** stateless. Open MCP sessions are in-memory only and are drained on
  shutdown; losing them costs a reconnect, not data.
- **PostgreSQL:** the single durable store. Schema is versioned through the
  `schema_migrations` table and forward-only migrations.
- **Local STDIO:** in-memory, ephemeral, single-user (PR7).

## Failure & recovery posture

- A down database fails `/readyz` (503) while `/healthz` stays 200, so the load
  balancer removes the instance without the supervisor killing it.
- Startup misconfiguration fails fast with a specific code before the port binds.
- Recovery is `pg_dump`/`pg_restore` of the control plane plus redeploying a
  matching server version — see [`OPERATIONS.md`](OPERATIONS.md).
