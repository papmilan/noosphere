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
| A `pool-error` log line appears | An idle pooled database connection failed (DB restart/failover/network drop) | Informational: the server logs it and keeps running — it does **not** crash. `/readyz` reports 503 until the database answers again, then returns to 200 with no restart. |
| All `/mcp` requests 401 | Token invalid/expired, wrong issuer or audience, or `jwks_uri` unreachable | Verify `NOOSPHERE_AUDIENCE`/`NOOSPHERE_OIDC_ISSUERS` match the IdP; confirm the server can reach each `jwks_uri`. Errors are deliberately opaque (no detail leaked to clients). |
| `/mcp` returns 403 `forbidden-origin` | Browser `Origin` not in `NOOSPHERE_ALLOWED_ORIGINS` | Add the origin. |
| `/mcp` returns 403 `session-owner-mismatch` | A token for a different owner reused an existing `Mcp-Session-Id` | Client bug; sessions are owner-bound. |
| `/mcp` returns 404 `unknown-session` for a formerly valid ID | The process restarted, affinity routed to another replica, or the session exceeded `NOOSPHERE_MCP_SESSION_TTL_MS` | Reconnect and initialize a new MCP session. Confirm session affinity for multi-replica deployments. |
| New `/mcp` initialization returns 503 `session-capacity` | `NOOSPHERE_MAX_MCP_SESSIONS` live sessions are occupied | Clients should retry after the advertised `Retry-After`; reduce the TTL, raise the bounded cap within host memory limits, or add an affinity-aware replica. |
| `/mcp` returns 413 | Body over `NOOSPHERE_MAX_BODY_BYTES` | Raise the limit (≤64 MiB) or reduce payload size. |
| Port bind failure (`EADDRINUSE`) | `NOOSPHERE_PORT` already in use | Change the port or free it. |
| OIDC verification intermittently fails | JWKS endpoint flapping / key rotation | Confirm IdP key rotation and network egress to the JWKS host. |

## Backup and restore (PostgreSQL)

All durable state is in the control-plane database. Back it up with standard
PostgreSQL tooling.

Do **not** pass a credential-bearing `DATABASE_URL` (or `--dbname` with an
embedded password) as a command-line argument — connection strings on the
command line are visible to any local user through `ps`/process listings, which
contradicts the handling required in [`CONFIGURATION.md`](CONFIGURATION.md).
Supply the password out of band via a `.pgpass` file or the `PGPASSWORD`
environment variable, and pass only non-secret connection parameters.

**On a host with a `.pgpass` file** (one `hostname:port:database:username:password`
line, mode **0600** — libpq refuses looser permissions):

```sh
# One-time setup, kept out of shell history:
install -m 600 /dev/null ~/.pgpass
printf 'db:5432:noosphere_project_memory:noosphere:REPLACE_ME_PASSWORD\n' >> ~/.pgpass
```

```sh
# Backup — password comes from ~/.pgpass, never the command line:
pg_dump --format=custom --no-owner \
  -h db -p 5432 -U noosphere -d noosphere_project_memory \
  > "noosphere-$(date +%F).dump"
```

```sh
# Restore into an empty database (same ~/.pgpass):
pg_restore --clean --if-exists --no-owner \
  -h db -p 5432 -U noosphere -d noosphere_project_memory \
  "noosphere-YYYY-MM-DD.dump"
```

**Inside the compose stack**, run from a one-off container so the secret stays in
the container environment (`$POSTGRES_PASSWORD`, already loaded from the env
file) and is never typed or placed in host argv:

```sh
docker compose --env-file deploy/noosphere.env -f deploy/docker-compose.yml \
  run --rm --no-deps -T db \
  sh -lc 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump --format=custom --no-owner \
    -h db -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "noosphere-$(date +%F).dump"
```

`PGPASSWORD` is an environment variable inside the container, not a command
argument, so it does not appear in host process listings. **A dump contains all
project data — store dumps encrypted and access-controlled.**

Take backups on a schedule and before every upgrade. Owner-scoped export/delete
jobs also exist in the repository layer for per-owner data-subject requests
(GDPR-style export/delete) — those are application operations, not a substitute
for full backups. An export aggregates the project and its child collections in
one SQL statement, giving a single MVCC snapshot. A retention purge locks and
rechecks the current marker before deleting, so a stale candidate list cannot
override an extension made concurrently.

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
4. Roll the server (`docker compose --env-file deploy/noosphere.env -f deploy/docker-compose.yml up -d`
   / `systemctl restart`). Durable data survives a restart; in-flight MCP sessions
   do not (they are process-local — see the multi-replica note in
   [`DEPLOYMENT.md`](DEPLOYMENT.md#1-docker-compose-recommended-reference)).
   Keep `NOOSPHERE_CURSOR_SECRET` unchanged across the rollout so outstanding
   pagination cursors remain valid on old and new replicas.
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
Memory service and repository. Operators must not hand-edit rows in the
control-plane database; use the MCP tools or the defined owner-scoped repository
jobs so those invariants hold.
