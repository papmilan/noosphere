# Remote Project Memory PR 5 — cross-client continuity acceptance TDD plan

- **Status:** Proposed  ·  **Base:** `065c984`  ·  **Branch:** `codex/remote-project-memory-acceptance`
- **Design:** `docs/design/specs/2026-07-20-remote-project-memory-pr5-acceptance-design.md`
- **Approved forks:** new `noosphere-remote-mcp-acceptance` package; MCP SDK `Client`
  protocol stand-in + documented client matrix; in-memory repository only.

## Consumed APIs (all as-is, no modification)
- Server: `createMcpServer` from `noosphere-remote-mcp-server/src/server.js` (sibling source).
- Core: `InMemoryProjectMemoryRepository` + `validCheckpoint` fixture from
  `@noosphere/remote-mcp-contracts` (declared dep, by specifier).
- OIDC: `OidcVerifier` from `noosphere-remote-mcp-postgres/src/oidc.js` (sibling source; CI installs it).
- MCP SDK: `Client` + `StreamableHTTPClientTransport` (devDependency); `jose` for token minting.

Each slice is one reviewable commit, test-first.

## Slice 1 — acceptance harness + Bicycle Repair continuity
- `tests/harness.js`: start the real server (ephemeral port, in-memory repo, RS256 verifier
  with local keys), a `connect(token)` SDK-client factory, and a `token({sub})` minter.
- Test: client A (`chatgpt`) creates "Bicycle Repair", opens a session, saves a checkpoint;
  client B (`claude`) opens a new session and `resume_project` returns A's latest checkpoint
  with `content_trust: untrusted-persisted-data`. Same owner, two clients, continuity holds.

## Slice 2 — Architecture Phase 1→2 + separate projects
- Architecture: two checkpoints advancing `current_status` Phase 1 → Phase 2; resume and
  `get_project_summary` reflect the Phase 2 head, never Phase 1.
- Separate projects: two projects for one owner; resume/summary/find of one never surface
  the other's checkpoints; cross-project checkpoint access is `not-found`.

## Slice 3 — ambiguity + interrupted session
- Ambiguity: two projects whose names share a discovery substring; `find_projects` on the
  substring → `ambiguous` (≥2 candidates); exact normalized name → `resolved`.
- Interrupted session: an active session whose latest activity precedes a later checkpoint
  horizon → resume yields a bounded `interrupted-session`/`stale` warning validating against
  the published `resume_project` warning schema; no inconsistent head projected.

## Slice 4 — cross-user denial + global-verification assertions
- Cross-user denial: owner B cannot `get_project`/`resume_project`/`find_projects`/
  `get_checkpoint` owner A's data over the transport → typed `not-found`, no existence oracle.
- Global verification asserted: continuity achieved with **no Git repo, no local folder, no CLI,
  no user-run MCP process** (client is a network MCP client; server holds injected state);
  recalled content marked untrusted; a checkpoint carrying a `transcript`/`chain_of_thought`
  key is rejected at the boundary (no hidden-reasoning capture).

## Slice 5 — supported-client matrix doc + CI + scope
- `docs/` supported-client matrix: what is proven automatically vs. the ChatGPT/Claude
  manual-validation checklist under specific account/workspace/transport/OAuth configs;
  explicit "no universal client support" statement.
- CI: dedicated least-privilege `noosphere-remote-mcp-acceptance` job (contents: read,
  checkout persist-credentials: false, in-memory — no PostgreSQL); installs the server and
  PR3 siblings for the source imports, mirroring the PR4 pattern. Existing jobs unchanged.
- Confirm existing suites untouched; changes confined to the new package + docs + CI.

## Global verification
- `node --check`; full acceptance suite green through the real server + real OIDC; core,
  PostgreSQL, and server suites unchanged; `npm audit`; `git diff --check`; scope confined;
  clean-boundary install/test from empty `node_modules`.
