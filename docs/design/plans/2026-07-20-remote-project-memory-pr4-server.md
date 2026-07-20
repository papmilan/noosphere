# Remote Project Memory PR 4 — remote MCP server TDD plan

- **Status:** Proposed  ·  **Base:** `4c00813`  ·  **Branch:** `codex/remote-project-memory-server`
- **Design:** `docs/design/specs/2026-07-20-remote-project-memory-pr4-server-design.md`
- **Approved forks:** `@modelcontextprotocol/sdk` (v1.29) Streamable HTTP; `node:http`;
  new `noosphere-remote-mcp-server` package; in-memory-repo tests (+ optional PG smoke).

## Consumed APIs
- `@modelcontextprotocol/sdk/server/index.js` → `Server`, `setRequestHandler`, `connect`.
- `@modelcontextprotocol/sdk/server/streamableHttp.js` → `StreamableHTTPServerTransport({ sessionIdGenerator })`, `handleRequest(req,res,body)`.
- `@modelcontextprotocol/sdk/types.js` → `InitializeRequestSchema`, `ListToolsRequestSchema`, `CallToolRequestSchema`.
- Core `MCP_TOOLS`, `ProjectMemoryService`, `InMemoryProjectMemoryRepository`, `MCP_ERROR_CODES` (relative import).
- PR3 `OidcVerifier` (relative import) for bearer verification.

Each slice is one reviewable commit, test-first.

## Slice 1 — package scaffold + config (no server)
- `package.json` (deps above), config loader: issuers/audience/allowed origins/port/repository factory; validate + reject a production config that enables test identities.
- Test: config validation (missing audience, production+test-identity rejected).

## Slice 2 — protected-resource metadata + 401 (no MCP yet)
- `GET /.well-known/oauth-protected-resource` → resource + authorization_servers + scopes (RFC 9728).
- Helper that builds a `401` with `WWW-Authenticate: Bearer resource_metadata="…"`.
- Test (node:http on an ephemeral port): metadata body shape; unauthenticated `/mcp` → 401 + header.

## Slice 3 — auth + Origin middleware
- Extract bearer, `OidcVerifier.verify` → `{ ownerScope, subject }`; missing/invalid → 401.
- Origin allowlist check → 403 on disallowed Origin.
- Test: valid token passes and yields ownerScope; invalid/expired → 401; bad Origin → 403; owner isolation (two subjects → two scopes).

## Slice 4 — MCP initialize + tools/list
- Per session: build a `Server` whose handlers close over the authenticated ownerScope + a `ProjectMemoryService`; `sessionIdGenerator: randomUUID`; map sessionId → session; re-verify token per request and bind subject (reject subject change on an existing session).
- `tools/list` returns `MCP_TOOLS` names + input schemas.
- Test (MCP client over the in-memory transport pair, or HTTP): initialize handshake; tools/list = 15 tools.

## Slice 5 — tools/call dispatch
- Static table mapping each `MCP_TOOLS` name → `ProjectMemoryService` method; validate input against `MCP_TOOLS[name].input`; wrap bare entity returns into `{ project }` / `{ session }` envelopes; map typed MCP errors to `CallTool` error results; unknown tool → invalid-argument.
- Retry-safe: `save_checkpoint` with the same idempotency key replays.
- Test: create_project→get→find; save_checkpoint retry replays; cross-owner call cannot read another owner's project; invalid input → error.

## Slice 6 — health/readiness + correlation/redaction + graceful shutdown
- `GET /healthz` (200), `GET /readyz` (checks repository reachability), per-request correlation id, log redaction of Authorization/token/content, SIGTERM drain + pool close.
- Test: healthz/readyz; redaction never logs the token; shutdown resolves.

## Slice 7 — acceptance + CI + scope
- Full session: initialize → list → call (success, error, retry-safe) end to end.
- CI job (no DB needed; optional PG smoke behind the PR3 service).
- Confirm existing suites untouched; changes confined to the new package + docs + CI.

## Global verification
- `node --check`; full server test suite; core 70/70, postgres package, ACP, relayer unchanged; `npm audit`; `git diff --check`; scope confined.
