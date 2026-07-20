# Remote Project Memory PR 3 — PostgreSQL + OIDC TDD plan

- **Status:** Proposed
- **Base:** `b71c04f`  ·  **Branch:** `codex/remote-project-memory-postgres`
- **Design:** `docs/design/specs/2026-07-20-remote-project-memory-pr3-postgres-oidc-design.md`
- **Approved forks:** new package `noosphere-remote-mcp-postgres`; real Postgres
  (Docker Compose + CI service); `pg`; `jose`; plain-SQL forward-only migrations.

## Verification environments

- **Local, no DB:** `node --check`, OIDC verifier unit tests (`jose`, no DB),
  migration SQL lint, package/dep dry-runs. Runs in this environment.
- **DB-backed:** the shared repository parity suite + transactional/idempotency/
  race tests require a live Postgres. Run against Docker Compose locally **or** a
  Postgres service container in CI. Every slice that needs the DB states so.

Each slice is one reviewable commit, test-first (RED → GREEN → commit).

## Slice 1 — package scaffold (no DB)
- `noosphere-remote-mcp-postgres/package.json` (private, type=module, deps `pg`,
  `jose`; devDep on the core package via file link for parity fixtures).
- `docker-compose.yml` (Postgres 16, healthcheck, ephemeral volume).
- `migrate.js` forward-only runner (apply ordered `migrations/*.sql`, record
  applied versions in a `schema_migrations` table). Unit-test the version
  ordering/parse logic without a DB.
- CI: add a `noosphere-remote-mcp-postgres` job with a Postgres service.
- Verify: `node --check`, runner ordering unit test.

## Slice 2 — schema + connection + owner-scope guard (DB)
- `migrations/0001_init.sql`: `projects`, `sessions`, `checkpoints`,
  `project_aliases`, `idempotency_receipts`, `retention_markers`,
  `schema_migrations`. Owner-scope column everywhere; collision-safe PKs;
  `unique (owner_scope, project_id, revision)`; `unique (owner_scope, operation,
  idempotency_key)`; head FK/CAS columns.
- `pool.js` (parameterized queries, single pool, tx helper `withTransaction`).
- `ownerScope` guard: reject missing/oversized scope exactly as the port asserts.
- Verify (DB): migration applies cleanly; schema matches the constraint set.

## Slice 3 — project lifecycle (DB)
- `createProject/getProject/listProjects/replaceProject/deleteProject`.
- Delete cascades sessions/checkpoints/aliases and only that owner/project's
  receipts.
- Verify (DB): parity subset for projects + cross-owner isolation.

## Slice 4 — sessions + transactional checkpoint (DB)
- `createSession/getSession/listSessions/replaceSession`, `getCheckpoint`,
  `listCheckpoints`, and the single-transaction `saveCheckpoint` (insert
  checkpoint, CAS project head, CAS session head, write receipt — all-or-nothing).
- Enforce strict linear history via `unique(revision)` + predecessor/head checks;
  operation-scoped idempotency (same key/diff hash → conflict; replay → stored).
- Verify (DB): full parity suite for sessions/checkpoints; concurrent
  saveCheckpoint race (two writers, one wins) via real transactions.

## Slice 5 — inspect, idempotency, quota/retention, export/delete (DB)
- `inspectProjectState`, `recordIdempotency`; per-owner quota enforcement;
  retention markers; owner-scoped export and hard-delete jobs.
- Verify (DB): parity for inspect/idempotency; quota rejection; export/delete
  cascade; storage-unavailable surfaces a typed error.

## Slice 6 — OIDC verifier (no DB)
- `oidc.js`: verify `iss` (allow-list), `aud`, JWKS signature (cached, rotation),
  `exp/nbf`, required scopes; derive `owner_scope = issuer:<iss>|subject:<sub>`.
- Dev-only test-identity injector gated behind an explicit development flag;
  a production configuration that loads it is a hard startup error.
- Verify (no DB): issuer/audience/expiry/signature/scope tests with locally
  generated keys via `jose`; cross-subject → distinct owner scopes; production
  config rejects the injector.

## Slice 7 — conformance + resilience + CI (DB)
- Run the **exact** `repository-core.test.js` behavioral suite against the
  Postgres adapter (shared fixtures) to prove in-memory parity.
- Cross-owner isolation end-to-end; idempotency races; unavailable-storage.
- Wire CI to run non-DB tests always and DB tests against the service container;
  confirm existing suites (core 70/70, ACP 4/4, relayer 92/1-skip) untouched.

## Global verification (Task-6 equivalent)
- Non-DB local: `node --check`, OIDC + runner tests, lint, dry-runs.
- DB (Docker/CI): full parity + resilience suite green.
- `git diff --check`; changes confined to `noosphere-remote-mcp-postgres/` + `docs/`;
  no edit to the merged core, ACP, relayer, or continuity; no PR4 transport code.
