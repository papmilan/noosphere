# Remote Project Memory PR 4 — remote MCP server (design)

- **Status:** Proposed — awaiting fork approval before implementation
- **Date:** 2026-07-20
- **Base:** `4c00813` (merged `main`, after PR #16)
- **Branch:** `codex/remote-project-memory-server`
- **Governing ADRs:** 0003 (service boundary), 0005 (provider-neutral OIDC protected resource)

## 1. Scope (delivery plan, PR 4)

An **independent Streamable HTTP MCP service** that exposes the merged Project
Memory tools to remote MCP clients, authenticated as an OAuth 2.1 protected
resource. It wires existing pieces only — it adds transport, auth enforcement,
and operational surface, no new domain logic:

1. **Streamable HTTP MCP transport** — `POST /mcp` handling MCP `initialize`,
   `tools/list`, `tools/call`, with correct error and retry-safe semantics.
2. **Protected-resource metadata** — `GET /.well-known/oauth-protected-resource`
   (RFC 9728); `401` responses carry `WWW-Authenticate` pointing at it.
3. **Auth enforcement** — every tool call requires a bearer token; the PR3
   `OidcVerifier` validates it and derives `owner_scope`; the request is served
   by `new ProjectMemoryService({ repository })` bound to that scope. No tool
   input ever carries owner/subject/token.
4. **Origin validation** — reject disallowed `Origin` headers (DNS-rebinding /
   cross-site protection per MCP security guidance).
5. **Request correlation + redaction** — per-request correlation id; logs redact
   `Authorization`, tokens, and user content.
6. **Health / readiness** — `GET /healthz` (liveness), `GET /readyz` (readiness,
   incl. storage reachability).
7. **Graceful shutdown** — SIGTERM stops intake, drains in-flight requests, closes
   the storage pool.

## 2. Out of scope (deferred / forbidden)

- **No OAuth authorization flow** — this is the *resource server*; it verifies
  tokens and publishes resource metadata. Authorization endpoints, browser
  login/callbacks, token exchange, and refresh tokens belong to the identity
  provider, not here.
- No cookies or sessions (bearer tokens only).
- **No local filesystem access; no import of the existing relayer runtime.**
- No deployment/runtime orchestration (PR 6), no cross-client acceptance (PR 5).
- No change to the merged core (`noosphere-remote-mcp`) or PR3
  (`noosphere-remote-mcp-postgres`) observable behaviour; both are consumed as-is.
- The recorded PR2/PR3 follow-ups stay out of this PR.

## 3. Request path (per tool call)

```
POST /mcp  (Origin checked) ->
  Authorization: Bearer <jwt> -> OidcVerifier.verify -> { ownerScope }
    -> MCP method dispatch:
       initialize        -> capabilities + serverInfo
       tools/list        -> MCP_TOOLS (from the core contract)
       tools/call <name> -> validate input vs MCP_TOOLS[name].input
                            -> ProjectMemoryService[method]({ ownerScope, input })
                            -> map domain result / typed error to MCP result
  missing/invalid token -> 401 + WWW-Authenticate (resource metadata URL)
```

Tool→service mapping is a static table over the 15 `MCP_TOOLS` entries. Bare
single-entity service returns are wrapped into the published MCP output
envelopes (the PR2 transport-envelope follow-up is discharged here, at the
transport boundary, without touching core).

## 4. Decision forks — need approval before implementation

| # | Fork | Proposed default | Rationale |
|---|------|------------------|-----------|
| F1 | **MCP transport** | Official `@modelcontextprotocol/sdk` Streamable HTTP server transport | Canonical, provider-neutral, correct initialize/session/SSE semantics; avoids hand-rolling a spec-sensitive protocol. Trade-off: a real dependency in a minimal-dep repo. |
| F2 | **HTTP layer** | `node:http` (no Express) | The SDK transport mounts on a plain Node handler; keeps deps minimal. |
| F3 | **Package layout** | New `noosphere-remote-mcp-server` depending on the core + postgres packages | Consistent with the PR1–PR3 package boundaries. |
| F4 | **Test strategy** | MCP-layer tests against the **in-memory** repository (fast, no DB) + OIDC verifier with local keys; a thin optional Postgres-backed smoke path reusing PR3's service container | initialize/list/call/errors/retry-safety and auth/origin/metadata are storage-agnostic; the DB path is already proven in PR3. |

If F1 is declined, the fallback is a hand-rolled JSON-RPC-over-HTTP + SSE
transport on `node:http` — more code, more spec risk, zero new dependency.

## 5. Proposed slice plan (TDD, one reviewable slice per commit)

1. Package scaffold + chosen deps + config loader (issuers/audience/origins/port).
2. OAuth protected-resource metadata endpoint + `401`/`WWW-Authenticate`.
3. Auth + Origin middleware (verify bearer → ownerScope; reject bad origin).
4. MCP transport wiring: `initialize`, `tools/list`.
5. `tools/call` dispatch table → core service, with input validation, result
   wrapping, and typed-error → MCP-error mapping; retry-safe (idempotency) calls.
6. Health/readiness, correlation-id + redaction logging, graceful shutdown.
7. Acceptance: full MCP session (initialize→list→call incl. error and
   retry-safe cases); CI job; scope containment.

## 6. Verification target

- MCP `initialize` / `tools/list` / `tools/call` happy-path, error, and
  retry-safe (idempotent) flows.
- Auth: missing/invalid/expired token → `401` + metadata pointer; valid token →
  scoped service call; no cross-owner access via the transport.
- Origin rejection; health/readiness; graceful shutdown; correlation/redaction.
- Existing suites (core 70/70, postgres package, ACP, relayer) untouched and green.
- Changes confined to the new package + `docs/` + CI.

## 7. Open question for the maintainer

Approve the four forks in §4 — in particular **F1** (official MCP SDK vs
hand-rolled transport) and **F4** (in-memory-first test strategy). Production
code begins only after the design and the subsequent TDD plan are approved.
