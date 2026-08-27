# Project Memory Storage and Lifecycle Contract

## Storage port

Every repository method accepts a server-derived `ownerScope`. The common port
supports project/session/checkpoint reads and writes, atomic checkpoint save,
idempotency receipts, inspection, and deletion. Deterministic matching,
pagination, archive, resume, and summaries are service behavior above the port.
The in-memory implementation is both the executable contract model and a test
backend. PostgreSQL is the production remote adapter. Local STDIO extends the
in-memory implementation with load-on-open and owner-only atomic snapshot
persistence.

Checkpoint history is strictly linear in v1: revision 1 has no predecessor;
every later revision points to the current head in the same owner scope and
project and has exactly the predecessor's revision plus one. Branches and
cycles are rejected. Both repository implementations make head comparison,
checkpoint insertion, project/session head updates, and idempotency receipt
insertion one logical transaction; PostgreSQL uses a database transaction and
row locks.

The public Project record is the sole source of truth for a project's current
checkpoint head: a committed checkpoint atomically sets
`latest_checkpoint_id` to that checkpoint ID. The service owns timestamps:
project update/archive change both `updated_at` and `last_activity_at`; session
create/transition also touches project activity; checkpoint save commits the
server timestamp with the project/session heads. Repositories preserve the
later server-owned activity value when a locked record changed concurrently.

Idempotency scope is `(authenticated owner, operation name, idempotency key)`.
A matching committed request hash replays its committed success; a different
hash conflicts; a failed transaction commits no receipt. PostgreSQL serializes
concurrent retries through its transaction and unique constraints.

Repository tuple identity preserves component boundaries; it must use a
collision-safe tuple representation (such as nested maps or typed database
columns), never a delimiter-joined string.

Internal `ProjectRecord` carries `owner_scope`; public project values and MCP
inputs do not.

## Lifecycle

- **active / paused / completed:** schema-defined Project states. `status` is
  the only lifecycle source of truth; there is no redundant `archived` boolean.
  The current public MCP surface creates active projects and exposes archive;
  it does not expose a general project-status transition tool.
- **archived:** hidden from default listings; retained and retrievable by
  explicit request where policy permits.
- **deleted:** an owner-scoped repository/operator operation, not a public MCP
  tool and not an archive synonym. It removes the project, sessions,
  checkpoints, idempotency records, and retention marker.
- **retention:** PostgreSQL exposes owner-scoped marker/list/purge job methods.
  The deployment chooses the duration; the protocol does not invent one. Purge
  candidate lists are advisory: each deletion transaction locks the current
  project and retention rows and rechecks the marker, so a concurrent extension
  cannot be erased using a stale candidate.
- **export:** PostgreSQL exposes an owner-scoped structured project snapshot for
  operator/data-subject workflows. The project, sessions, and checkpoints are
  aggregated by one SQL statement and therefore come from one PostgreSQL MVCC
  snapshot. No hidden model data exists to export.

## Development and production boundaries

Local database development uses the disposable Compose service in
`noosphere-remote-mcp-postgres/docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: noosphere_project_memory
      POSTGRES_USER: noosphere
      POSTGRES_PASSWORD: noosphere
    ports: ["5433:5432"]
    tmpfs: ["/var/lib/postgresql/data"]
```

That database is test data only. The production reference environment uses
HTTPS, OIDC, PostgreSQL, forward-only migrations, backups, and explicit
retention operations. Deployment assets and the exact runbooks are in
[`../remote-mcp/`](../remote-mcp/README.md).
