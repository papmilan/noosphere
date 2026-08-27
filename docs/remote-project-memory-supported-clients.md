# Remote Project Memory — supported clients

> **No universal client support is claimed.** The remote MCP server implements
> the MCP Streamable HTTP transport and OAuth 2.1 protected-resource semantics.
> Whether a given client app can connect depends on that client's own support
> for the selected transport and OAuth flow, and on account/workspace policy.
> Only the configurations listed below are validated.

## What is proven automatically (CI)

The `noosphere-remote-mcp-acceptance` suite drives the real server with the
official `@modelcontextprotocol/sdk` client over Streamable HTTP and a real OIDC
verifier. It proves, at the protocol level:

- MCP `initialize` → `tools/list` → `tools/call` continuity;
- **Bicycle Repair** cross-client continuity (one owner, `chatgpt` then `claude`
  session, resume returns the prior head);
- **Architecture Phase 1→2** progression (resume/summary reflect the Phase 2 head);
- separate-project isolation and cross-project `not-found`;
- ambiguity never silently resolves; exact name resolves;
- interrupted-session bounded warning without projecting an inconsistent head;
- cross-user denial (typed `not-found`, no existence oracle);
- recalled content marked `untrusted-persisted-data`;
- rejection of checkpoints smuggling `transcript` / `chain_of_thought`;
- idempotency: identical-payload replay deduplicates, and a conflicting payload
  under the same key returns a typed `idempotency-conflict` that creates no
  second checkpoint and leaves the original intact (both transports);
- cursor pagination over a multi-page list with no duplicates/omissions and
  stable order (both transports), and a tampered opaque cursor rejected with a
  typed `invalid-argument` (clients never decode cursor internals);
- discovery resolution by NFKC-equivalent name, exact normalized name, exact
  alias, and exact id, with substring/ambiguous matches never silently resolving;
- deterministic bounded concurrency: cross-owner isolation under concurrent
  requests, and exactly one checkpoint for concurrent identical retries;
- full continuity with **no Git repo, local folder, CLI, or user-run MCP process**.

The SDK client is a faithful protocol stand-in; it is **not** the ChatGPT or
Claude application. Real client-app behavior is validated manually below.

## Deliberately outside this acceptance suite

- **Deletion.** `delete_project` is **not** part of the current public MCP tool
  surface (the surface is the 16 tools listed above). Delete and post-delete
  transport acceptance is therefore not applicable: there is no public tool to
  exercise. Owner-scoped deletion remains an operator/repository operation.
- **PostgreSQL-backed acceptance.** This suite runs the server against an
  in-memory repository for deterministic transport testing; it does not claim
  PostgreSQL coverage. The PostgreSQL repository has separate parity,
  concurrency, migration, export, deletion, and retention suites in
  `noosphere-remote-mcp-postgres`.

## Manual client-validation matrix

Each row is validated by hand against a live deployment before being marked
supported. An unlisted client, account tier, or transport is **not** supported
until validated.

| Client | Transport | Auth flow | Account / workspace scope | Status |
|--------|-----------|-----------|---------------------------|--------|
| Claude (web/desktop) | Streamable HTTP MCP connector | OAuth 2.1 auth-code + PKCE to the configured IdP; RFC 9728 resource metadata | Workspaces where custom/remote MCP connectors are permitted by policy | Validate per deployment |
| ChatGPT (custom connector / MCP) | Streamable HTTP MCP | OAuth 2.1 auth-code + PKCE; RFC 9728 resource metadata | Plans/workspaces that allow custom MCP connectors | Validate per deployment |
| MCP SDK client (`@modelcontextprotocol/sdk`) | Streamable HTTP | Bearer via the configured verifier | Any | Automated (CI) |

### Manual validation checklist (per client, per deployment)

1. Discover protected-resource metadata at `/.well-known/oauth-protected-resource`.
2. Complete the client's OAuth flow against the configured IdP; obtain a bearer
   token with the required scopes.
3. `initialize` + `tools/list` returns the 16 Project Memory tools.
4. Run the Bicycle Repair and Architecture Phase 1→2 flows end to end.
5. Confirm cross-user denial with a second identity.
6. Confirm the client sends `Origin`/`Accept` acceptably and honors the
   `Mcp-Session-Id` header.

Record the client version, workspace policy, and IdP configuration alongside the
result. Do not generalize a passing row to other clients, tiers, or transports.
