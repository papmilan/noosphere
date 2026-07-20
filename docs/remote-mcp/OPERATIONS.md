# Remote Project Memory — Operations guide

Day-2 operations for the Remote MCP server: observability, diagnosis, backup,
restore, upgrade, and rollback. For first deploy see [`DEPLOYMENT.md`](DEPLOYMENT.md);
for the environment contract see [`CONFIGURATION.md`](CONFIGURATION.md).

## Endpoints

| Path | Method | Auth | Purpose |
| --- | --- | --- | --- |
| `/healthz` | GET | none | **Liveness**. Never touches the database. 200 as long as the process is up. |
| `/readyz` | GET | none | **Readiness**. In postgres mode runs `select 1`; 200 `ready` / 503 `unavailable`. Gate load-balancer traffic on this. |
| `/.well-known/oauth-protected-resource` | GET | none | RFC 9728 metadata (audience, authorization servers, scopes). |
| `/mcp` | POST/GET/DELETE | Bearer | Streamable HTTP MCP transport. |

Use `/healthz` for container liveness and process supervisors; use `/readyz`
for the load balancer, so a server with a down database is pulled from rotation
without being killed.

## Logging

Structured JSON, one object per line (`NOOSPHERE_LOG=json`, the default). Each
request line carries a `correlationId`, method, path, status, and **redacted**
headers. Sensitive headers (`authorization`, `cookie`, `x-api-key`,
`proxy-authorization`) are replaced with `[redacted]`, and **tool arguments,
project names, and memory content are never logged**.

- **Recommended production level:** `json`. Use `silent` only when an external
  wrapper handles logging.
- **Rotation:** the process writes to stdout/stderr; rotation is the platform's
  job — Docker log driver (`json-file` with `max-size`/`max-file`, or
  `journald`) or systemd's journal.
- **journalctl:**
  ```sh
  journalctl -u noosphere-remote-mcp -f            # follow
  journalctl -u noosphere-remote-mcp --since "1h ago" -o cat | jq .status
  ```

## Startup validation

The server refuses to start on bad configuration (see
[`CONFIGURATION.md`](CONFIGURATION.md#startup-failure-codes)). A crash-looping
container almost always means a config error — read the first log line.

## Diagnosing common failures

| Symptom | Likely cause | Action |
| --- | --- | --- |
| Container exits immediately, `config-*` in logs | Missing/invalid env | Fix the named variable; see CONFIGURATION. |
| `/readyz` returns 503 | Database unreachable | Check `DATABASE_URL`, network to PostgreSQL, DB health. `/healthz` staying 200 confirms the process is fine. |
| All `/mcp` requests 401 | Token invalid/expired, wrong issuer or audience, or `jwks_uri` unreachable | Verify `NOOSPHERE_AUDIENCE`/`NOOSPHERE_OIDC_ISSUERS` match the IdP; confirm the server can reach each `jwks_uri`. Errors are deliberately opaque (no detail leaked to clients). |
| `/mcp` returns 403 `forbidden-origin` | Browser `Origin` not in `NOOSPHERE_ALLOWED_ORIGINS` | Add the origin. |
| `/mcp` returns 403 `session-owner-mismatch` | A token for a different owner reused an existing `Mcp-Session-Id` | Client bug; sessions are owner-bound. |
| `/mcp` returns 413 | Body over `NOOSPHERE_MAX_BODY_BYTES` | Raise the limit (≤64 MiB) or reduce payload size. |
| Port bind failure (`EADDRINUSE`) | `NOOSPHERE_PORT` already in use | Change the port or free it. |
| OIDC verification intermittently fails | JWKS endpoint flapping / key rotation | Confirm IdP key rotation and network egress to the JWKS host. |

## Backup and restore (PostgreSQL)

All durable state is in the control-plane database. Back it up with standard
PostgreSQL tooling.

**Backup:**
```sh
pg_dump --format=custom --no-owner "$DATABASE_URL" > noosphere-$(date +%F).dump
```

**Restore** (into an empty database):
```sh
pg_restore --clean --if-exists --no-owner --dbname "$DATABASE_URL" noosphere-YYYY-MM-DD.dump
```

Take backups on a schedule and before every upgrade. Owner-scoped export/delete
jobs also exist in the repository layer for per-owner data-subject requests
(GDPR-style export/delete) — those are application operations, not a substitute
for full backups.

## Migration safety

Migrations live in `noosphere-remote-mcp-postgres/migrations/` and are applied
by `node migrate.js`:

- Names are strictly ordered and must be contiguous (`0001_…`, `0002_…`).
- Migration runs take a **PostgreSQL advisory lock**, so concurrent migrators
  serialize instead of racing.
- Each migration runs in its own transaction; a failure rolls that migration
  back and aborts. Applied versions are recorded in `schema_migrations`.
- Re-running is safe: already-applied versions are skipped.

## Upgrade procedure

1. Back up the database (`pg_dump`).
2. Pull/build the new server image or package version.
3. Apply migrations **before** starting new code:
   ```sh
   DATABASE_URL=... node noosphere-remote-mcp-postgres/migrate.js
   ```
   (The compose stack's `migrate` one-shot does this automatically on `up`.)
4. Roll the server (`docker compose up -d` / `systemctl restart`). The server is
   stateless, so a restart loses no data.
5. Confirm `/readyz` is 200 and watch logs for the `listening` line.

## Rollback guidance

Migrations are **forward-only** — there are no down-migrations. To roll back:

1. Restore the pre-upgrade database dump.
2. Redeploy the previous server image/version.

Only roll back the database together with the code; a newer schema with older
code (or vice versa) is unsupported. Because migrations are additive and
advisory-locked, a failed upgrade that stopped mid-way leaves the schema at a
recorded version — restoring the dump returns it to a known state.

## Repository integrity expectations

Checkpoint-head and owner-isolation invariants are enforced in the Project
Memory service and repository (unchanged by this operational work). Operators
must not hand-edit rows in the control-plane database; do all writes through the
MCP tools so those invariants hold.
