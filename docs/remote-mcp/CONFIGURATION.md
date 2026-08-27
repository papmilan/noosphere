# Remote Project Memory — Configuration reference

Every setting the Remote MCP server (`noosphere-remote-mcp-server/src/main.js`)
reads from the environment. Configuration is validated at startup: **any
unknown `NOOSPHERE_*` variable is rejected** (`config-unknown-env:<KEY>`), and
missing or malformed required values fail fast before the port is bound.

Values are read once at boot. There is no config file and no runtime reload —
change the environment and restart.

## Variables

| Variable | Required | Default | Example | Purpose / security notes |
| --- | --- | --- | --- | --- |
| `NOOSPHERE_AUDIENCE` | Yes | — | `https://mcp.example/project-memory` | OAuth 2.1 resource identifier. Tokens whose `aud` does not match are rejected. |
| `NOOSPHERE_RESOURCE_METADATA_URL` | Yes | — | `https://mcp.example/.well-known/oauth-protected-resource` | Absolute URL of the RFC 9728 metadata document; also returned in `WWW-Authenticate` on 401. |
| `NOOSPHERE_OIDC_ISSUERS` | Yes | — | `[{"iss":"https://idp.example/","jwks_uri":"https://idp.example/jwks"}]` | JSON array of trusted issuers. `jwks_uri` **must be https**. Keys are fetched lazily from these JWKS endpoints. |
| `NOOSPHERE_AUTHORIZATION_SERVERS` | **Yes when production**, else No | empty | `https://idp.example/` | Space/comma list advertised in protected-resource metadata. Required under `NOOSPHERE_PRODUCTION=true` — otherwise RFC 9728 OAuth discovery would be silently incomplete. |
| `NOOSPHERE_REQUIRED_SCOPES` | No | empty | `project.read project.write` | Space/comma list every token must carry; missing scopes → 403. |
| `NOOSPHERE_ALLOWED_ORIGINS` | No | empty | `https://app.example` | Space/comma list of browser `Origin`s allowed on `/mcp`. Non-browser clients send no `Origin` and are unaffected. An unlisted origin → 403. |
| `NOOSPHERE_PRODUCTION` | No | `false` | `true` | Set **`true`** in production. Enables strict mode and forbids the in-memory repository and any test identities. |
| `NOOSPHERE_CURSOR_SECRET` | **Yes when production**, else No | random per process | output of `openssl rand -base64 48` | Encrypts and authenticates opaque pagination cursors. Use one owner-controlled value of at least 32 UTF-8 bytes across every restart and replica. Rotation intentionally invalidates outstanding cursors. |
| `NOOSPHERE_REPOSITORY` | No | `postgres` when production, else `memory` | `postgres` | Backing store. `memory` is ephemeral and rejected under production. |
| `DATABASE_URL` | Yes when `postgres` | — | `postgres://user:pass@db:5432/noosphere_project_memory` | PostgreSQL connection string. Contains a secret — keep it out of shell history / process listings; prefer a file-based secret. |
| `NOOSPHERE_PORT` | No | `8080` | `8080` | HTTP listen port (0–65535). `0` binds an ephemeral port (tests only). |
| `NOOSPHERE_LOG` | No | `json` | `json` | `json` (structured, recommended) or `silent`. |
| `NOOSPHERE_MAX_BODY_BYTES` | No | `1048576` (1 MiB) | `1048576` | Max request body. Bodies buffer in memory; ceiling is 64 MiB. |
| `NOOSPHERE_MCP_SESSION_TTL_MS` | No | `1800000` (30 min) | `1800000` | Idle timeout for process-local Streamable HTTP MCP sessions. Range: 1–604800000 ms (7 days). Activity refreshes the lease; an expired ID returns 404. |
| `NOOSPHERE_MAX_MCP_SESSIONS` | No | `1000` | `1000` | Process-wide live MCP session cap. Range: 1–100000. A new initialization receives 503 while the non-expired capacity is occupied. |
| `NOOSPHERE_PROJECTS_PER_OWNER` | No | unlimited | `100` | Per-owner project quota (postgres only). |

### docker-compose-only bootstrap variables

`deploy/docker-compose.yml` also reads `POSTGRES_USER`, `POSTGRES_PASSWORD`, and
`POSTGRES_DB` to initialise the bundled `db` service. Keep them consistent with
`DATABASE_URL`. They are irrelevant when you use a managed database.

## Security considerations

- **No secrets in the repo.** Only `*.example` templates are tracked;
  `deploy/noosphere.env` and `deploy/**/*.env` are git-ignored. The systemd
  `EnvironmentFile` should be `0600`, owned by the service user.
- **Keep the cursor secret stable and shared.** It is not stored in PostgreSQL.
  Every replica must receive the same secret through the deployment secret
  manager or pagination can fail when traffic moves between replicas. Do not log
  it. Deliberate rotation is safe but invalidates cursors already issued.
- **Signature algorithms are locked** to asymmetric JWKS families (RS/PS/ES/EdDSA).
  `alg=none` and symmetric `HS*` are refused — a shared secret can never forge a
  token.
- **Owner identity is derived only from verified claims** (`issuer:<iss>|subject:<sub>`).
  No client-supplied owner, subject, or token content is ever trusted.
- **HTTPS everywhere non-loopback**: `jwks_uri` must be https, and the server
  itself must sit behind a TLS-terminating proxy.
- **Test identities** can only be enabled on a non-production verifier; the
  production guard (`production-forbids-test-identities`) makes that combination
  unconstructable.

## Startup failure codes

The process exits non-zero with one of these before listening:

| Message | Meaning |
| --- | --- |
| `config-unknown-env:<KEY>` | An undocumented `NOOSPHERE_*` variable is set. |
| `config-requires:<KEY>` | A required variable is missing/empty (includes `NOOSPHERE_AUTHORIZATION_SERVERS`, `NOOSPHERE_CURSOR_SECRET`, and `DATABASE_URL` under production). |
| `config-requires-oidc-issuers` / `config-invalid-oidc-issuers-json` | `NOOSPHERE_OIDC_ISSUERS` is empty or not valid JSON. |
| `config-jwks-uri-requires-https` | A `jwks_uri` is not https. |
| `production-requires-postgres-repository` | `NOOSPHERE_PRODUCTION=true` with `NOOSPHERE_REPOSITORY=memory`. |
| `config-invalid-cursor-secret` | The cursor secret is shorter than 32 UTF-8 bytes or exceeds 4096 bytes. |
| `config-invalid-port` / `config-invalid-max-body-bytes` / `config-invalid-projects-per-owner` / `config-invalid-mcp-session-ttl-ms` / `config-invalid-max-mcp-sessions` | Numeric value out of range. |
