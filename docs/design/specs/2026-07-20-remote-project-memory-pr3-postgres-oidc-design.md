# Remote Project Memory PR 3 — PostgreSQL tenancy and OIDC (design)

- **Status:** Proposed — awaiting approval before implementation
- **Date:** 2026-07-20
- **Base:** `b71c04f` (merged `main`, after PR #15)
- **Branch:** `codex/remote-project-memory-postgres`
- **Governing ADRs:** 0003 (service boundary), 0004 (PostgreSQL control plane),
  0005 (provider-neutral OIDC), 0006 (Walrus out of v1)

## 1. Scope (from the delivery plan, PR 3)

Add, behind the existing pure-core service, the production storage and identity
layer:

1. **PostgreSQL migrations** — schema for projects, sessions, checkpoints,
   aliases, idempotency records, and retention markers.
2. **Transactional PostgreSQL repository** — a concrete implementation of the
   merged `ProjectMemoryRepository` port (14 methods) with identical observable
   semantics to `InMemoryProjectMemoryRepository`.
3. **Owner-scoped queries** — every read and write is filtered by an
   authenticated `owner_scope`; no method trusts a caller-supplied owner.
4. **Quota / retention configuration** — per-owner bounds and retention markers.
5. **Export / deletion jobs** — owner-scoped export and hard-delete cascade.
6. **Provider-neutral OIDC verifier** — validates issuer, audience,
   signature/key material, expiry, and required scopes, then derives
   `owner_scope` from the verified subject. Production rejects any test identity.

## 2. Out of scope (deferred, do not touch)

- HTTP / Streamable-MCP listener, protected-resource metadata, OAuth flow — **PR 4**.
- Cross-client continuity acceptance — **PR 5**.
- Deployment, runbooks, user docs — **PR 6**.
- Walrus / object-store artifact bytes — **ADR 0006**, out of v1 structured state.
- Any change to the merged pure-core `noosphere-remote-mcp` package (contracts,
  service, in-memory repository), to ACP, the relayer, or continuity.
- The four recorded PR-2 follow-ups (transition error code, resume duplicate-max
  hardening, transport envelope wrapping, cursor subkey separation) — these are
  core/transport concerns, not storage/identity, and stay out of PR 3.

## 3. Repository parity contract

The PostgreSQL repository must satisfy `POSTGRESQL_REPOSITORY_CONTRACT`:

- `owner_scope_required` — `owner_scope` column on every table; every statement
  filters by it.
- `collision_safe_tuple_keys` — primary keys are `(owner_scope, id)` /
  `(owner_scope, project_id, id)`; no delimiter-joined keys.
- `project_latest_checkpoint_is_head_source_of_truth` — `projects.latest_checkpoint_id`
  is the single head; checkpoint writes CAS against it.
- `strictly_linear_checkpoint_history_v1` — `unique (owner_scope, project_id, revision)`
  plus predecessor/head checks reject forks and non-linear writes.
- `transactions_for_revision_and_idempotency` — `saveCheckpoint` runs one
  transaction that inserts the checkpoint, advances project (and session) heads,
  and writes the idempotency receipt, or rolls all back.
- `operation_scoped_idempotency` — `unique (owner_scope, operation, idempotency_key)`;
  same key + different request hash → conflict; replay returns the stored result.
- `cursor_pagination` — keyset pagination ordered by the service's
  `(sort_key desc, id asc)`; the service still owns cursor encode/decode.
- `retention_configuration` — retention markers and per-owner quotas are
  queryable and enforced.

Conformance is proven by running the **same behavioral suite** that
`repository-core.test.js` runs against `InMemoryProjectMemoryRepository`, against
the PostgreSQL adapter, so the two implementations are observably identical.

## 4. OIDC verifier contract (ADR 0005)

- Verify: `iss` against allow-list, `aud` equals the resource identifier,
  signature against issuer JWKS (cached, key-rotation aware), `exp`/`nbf`,
  and required scopes.
- Derive `owner_scope` deterministically from verified claims (proposed:
  `issuer:<iss>|subject:<sub>`, matching the owner-scope string shape already
  used across the core tests). The subject is never accepted from tool input.
- Failures disclose neither project names nor ownership (generic
  `unauthenticated` / `forbidden`).
- **Production rejects test identities.** A local test-identity injector is
  available only when an explicit development-only flag is set; loading it under
  a production configuration is a hard startup error.

## 5. Decision forks — APPROVED 2026-07-20

| # | Fork | Decision | Rationale |
|---|------|----------|-----------|
| F1 | **Package layout** | **APPROVED:** new package `noosphere-remote-mcp-postgres` importing the core port; core stays zero-dep | Keeps the merged pure-core package dependency-free and independently testable |
| F2 | **Test-DB strategy** | **APPROVED:** real PostgreSQL via Docker Compose locally + a Postgres service container in CI; no in-memory SQL emulation | A transactional adapter (advisory locks, `unique` races, CAS) cannot be faithfully tested against `pg-mem`; ADR 0004 already mandates Docker Compose PG |
| F3 | **PG driver** | **APPROVED (default):** `pg` (node-postgres) | De-facto standard, parameterized queries, pooling |
| F4 | **OIDC/JWT lib** | **APPROVED (default):** `jose` | Provider-neutral, JWKS + full claim verification, no vendor lock-in |
| F5 | **Migrations** | **APPROVED (default):** plain SQL files + a minimal forward-only runner | Fewest dependencies; no migration framework needed for v1 |

## 6. Proposed slice plan (TDD, one reviewable slice per commit)

1. Package scaffold + `pg`/`jose` deps + Docker Compose + migration runner (no schema yet).
2. Schema migration + connection/pool module + owner-scope guard helper.
3. Project lifecycle methods (create/get/list/replace/delete) + parity tests.
4. Session + checkpoint methods incl. the transactional `saveCheckpoint` + linear-history/idempotency parity tests.
5. `inspectProjectState`, `recordIdempotency`, quota/retention, export/delete jobs.
6. OIDC verifier + owner-scope derivation + production-rejects-injector tests.
7. Full adapter-vs-port conformance run + storage-unavailable + cross-owner isolation + CI wiring.

## 7. Verification target

- The shared repository behavioral suite passes against the PostgreSQL adapter.
- OIDC unit tests: issuer, audience, expiry, signature, required scopes,
  cross-owner isolation, idempotency races, unavailable storage, and production
  configuration rejecting the test-identity injector.
- Existing suites (core 70/70, ACP 4/4, relayer 92/1-skip) remain untouched and green.
- No change to any file outside the new package + `docs/`.

## 8. Open question for the maintainer

Approve the five forks in §5 (or amend), and confirm PR 3 should proceed as a
**new `noosphere-remote-mcp-postgres` package** rather than extending the merged
core. Implementation (production code) begins only after this design and the
subsequent TDD plan are approved.
