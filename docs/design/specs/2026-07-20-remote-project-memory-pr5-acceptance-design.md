# Remote Project Memory PR 5 — cross-client continuity acceptance (design)

- **Status:** Proposed — awaiting fork approval before implementation
- **Date:** 2026-07-20
- **Base:** `065c984` (merged `main`, after PR #17)
- **Branch:** `codex/remote-project-memory-acceptance`
- **Governing ADRs:** 0003 (service boundary), 0005 (provider-neutral OIDC)

## 1. Scope (delivery plan, PR 5)

Protocol-client **acceptance tests** that exercise real cross-client continuity
end to end through the merged PR 4 Streamable HTTP server, plus an honest
**supported-client matrix**. This PR adds only tests, fixtures, a CI job, and
documentation. It adds **no new runtime code** and changes no observable
behaviour of the core, PostgreSQL, or server packages — all are consumed as-is.

Scenarios required by the plan, each driven over `POST /mcp` with a real MCP
client and a real bearer token:

1. **Bicycle Repair** — cross-client continuity: client A (`source_client:
   "chatgpt"`) creates the project, opens a session, saves checkpoints; client
   B (`source_client: "claude"`) opens a new session and `resume_project`
   returns A's latest checkpoint with `content_trust: untrusted-persisted-data`.
2. **Architecture Phase 1→2** — a project advances through checkpoints whose
   `current_status` moves from Phase 1 to Phase 2; resume/summary reflect the
   Phase 2 head, never a stale phase.
3. **Separate projects** — two projects for one owner stay isolated: resume and
   summary of one never leak the other's checkpoints.
4. **Ambiguity** — `find_projects` with a non-exact query that matches multiple
   candidates returns `ambiguous` and never silently resolves; an exact
   normalized name/alias resolves.
5. **Interrupted sessions** — a session left active past the checkpoint horizon
   yields a bounded `interrupted-session` / `stale` resume warning, never a
   crash and never a projected inconsistent head.
6. **Cross-user denial** — owner B cannot `get`/`resume`/`find` owner A's
   project through the transport (typed `not-found`, no existence oracle).

## 2. Honesty constraint (plan: "do not claim universal client support")

Automated CI **cannot** drive the real ChatGPT or Claude apps. The acceptance
suite therefore uses the official `@modelcontextprotocol/sdk` **`Client`** over
Streamable HTTP as a faithful **protocol-level** stand-in, and the PR ships a
**supported-client matrix** doc that states plainly:

- what is proven automatically (MCP protocol conformance + continuity semantics
  through the real server + real OIDC verification);
- which named clients (ChatGPT, Claude) are validated **only** under specific
  account / workspace / transport / OAuth-flow configurations, recorded as a
  manual checklist — **not** asserted as universal support.

## 3. Out of scope (deferred / forbidden)

- No new runtime code; no change to core / PostgreSQL / server observable
  semantics.
- No OAuth **authorization-server** implementation (still the IdP's job); the
  suite mints test tokens against the PR3 verifier's local keys.
- No deployment/runtime orchestration (PR 6); no local STDIO MCP mode (PR 7).
- No universal-client-support claim; no scraping or automating real client UIs.
- The recorded PR2/PR3/PR4 follow-ups stay out of this PR.

## 4. Global verification (plan requirement)

The suite must demonstrate, through assertions, that the remote service:

- needs **no Git repository, no local folder, no CLI, no user-run MCP process**
  — the client is a network MCP client and the server holds state in the
  injected repository;
- surfaces recalled checkpoint content as **untrusted** (`content_trust`);
- never captures hidden reasoning / transcripts (the core validator already
  rejects `chain_of_thought` / `transcript` keys — asserted at the boundary);
- preserves CSP/ACP compatibility (freshness warnings validate against the
  published `resume_project` warning schema).

## 5. Decision forks — need approval before implementation

| # | Fork | Recommended | Rationale |
|---|------|-------------|-----------|
| F1 | **Harness location** | New `noosphere-remote-mcp-acceptance` package (dev-only deps on server + core; OIDC verifier via the PR3 sibling like PR4's harness) | Cross-package E2E; a dedicated package keeps a clean boundary and its own CI job, consistent with one-package-per-PR. Alternative: `noosphere-remote-mcp-server/tests/acceptance` (no 4th package, but mixes unit and acceptance scope). |
| F2 | **Client driver** | Official MCP SDK `Client` over Streamable HTTP as the protocol stand-in; real ChatGPT/Claude validated by documented manual matrix | CI cannot drive real client apps; the SDK client is the faithful protocol proxy. |
| F3 | **Repository backend** | In-memory for CI determinism (matches PR4 F4); optional Postgres-backed acceptance variant deferred behind the PR3 service | Continuity semantics are storage-agnostic; the PG path is already proven in PR3. |
| F4 | **Supported-client matrix** | Ship a `docs/` matrix enumerating exactly the ChatGPT/Claude configs claimed, with an explicit "no universal support" statement | Directly discharges the plan's honesty constraint. |

## 6. Proposed slice plan (TDD, one reviewable slice per commit)

1. Acceptance harness (spin up the real server + verifier + in-memory repo;
   SDK client factory; token minting) + a first Bicycle Repair continuity test.
2. Architecture Phase 1→2 progression + separate-projects isolation.
3. Ambiguity + interrupted-session freshness.
4. Cross-user denial + "no Git/folder/CLI/MCP-process" and untrusted-content
   assertions.
5. Supported-client matrix doc + CI job (in-memory, least-privilege) + scope
   confinement check.

## 7. Verification target

- All acceptance scenarios green through the real server + real OIDC.
- Core, PostgreSQL, and server suites unchanged and green; `npm audit`;
  `git diff --check`; changes confined to the new acceptance package + docs +
  CI.

## 8. Open question for the maintainer

Approve the four forks in §4 — in particular **F1** (dedicated acceptance
package vs a `tests/acceptance` folder in the server package) and **F2**
(SDK-client protocol stand-in + documented manual client matrix). Production
code is not touched; implementation begins only after the design and the
subsequent TDD plan are approved.
