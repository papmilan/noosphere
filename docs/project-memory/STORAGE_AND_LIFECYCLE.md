# Project Memory Storage and Lifecycle Contract

## Storage port

Every repository method accepts a server-derived `ownerScope`. The port must
support project/session/checkpoint reads and writes, deterministic matching,
cursor listing, idempotency, archive, deletion, export, quotas, and retention.
The test-only in-memory implementation proves owner-scoped lookup,
strictly-linear checkpoint history, immutable checkpoint IDs, and
operation-scoped idempotent checkpoint persistence. It is not a production
backend.

Checkpoint history is strictly linear in v1: revision 1 has no predecessor;
every later revision points to the current head in the same owner scope and
project and has exactly the predecessor's revision plus one. Branches and
cycles are rejected. A PostgreSQL implementation must make head comparison,
checkpoint insertion, and idempotency receipt insertion one transaction.

Idempotency scope is `(authenticated owner, operation name, idempotency key)`.
A matching committed request hash replays its committed success; a different
hash conflicts; a failed transaction commits no receipt. Concurrent retries
are a transaction/unique-constraint concern for the production adapter.
Retention/TTL is deliberately deferred to deployment configuration.

Internal `ProjectRecord` carries `owner_scope`; public project values and MCP
inputs do not.

## Lifecycle

- **active / paused / completed:** normal Project states. `status` is the only
  lifecycle source of truth; there is no redundant `archived` boolean.
- **archived:** hidden from default listings; retained and retrievable by
  explicit request where policy permits.
- **deleted:** explicit lifecycle action, not an archive synonym. It must
  remove or cryptographically render unavailable related sessions,
  checkpoints, aliases, idempotency records, and future artifact references.
- **retention:** deployment configuration controls final retention duration.
  PR 1 deliberately does not invent a duration.
- **export:** a future owner-authenticated export returns structured project
  state only; no hidden model data exists to export.

## Development and production boundaries

Local development will use Docker Compose PostgreSQL in a later deployment PR.
The reference shape is deliberately provider-neutral:

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: noosphere_project_memory
      POSTGRES_USER: noosphere
      POSTGRES_PASSWORD: change-for-local-development
    ports: ["127.0.0.1:5432:5432"]
```

PR 3 will supply the runnable compose file, migration command, and non-default
credential guidance; this PR does not create infrastructure or a database.
The production reference environment is an EU-region deployment with HTTPS,
OIDC, PostgreSQL, and explicit backups/retention operations. No container,
migration, provider SDK, or database adapter exists in PR 1.
