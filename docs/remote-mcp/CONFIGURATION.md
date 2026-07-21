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
| `NOOSPHERE_REPOSITORY` | No | `postgres` when production, else `memory` | `postgres` | Backing store. `memory` is ephemeral and rejected under production. |
| `DATABASE_URL` | Yes when `postgres` | — | `postgres://user:pass@db:5432/noosphere_project_memory` | PostgreSQL connection string. Contains a secret — keep it out of shell history / process listings; prefer a file-based secret. |
| `NOOSPHERE_PORT` | No | `8080` | `8080` | HTTP listen port (0–65535). `0` binds an ephemeral port (tests only). |
| `NOOSPHERE_LOG` | No | `json` | `json` | `json` (structured, recommended) or `silent`. |
| `NOOSPHERE_MAX_BODY_BYTES` | No | `1048576` (1 MiB) | `1048576` | Max request body. Bodies buffer in memory; ceiling is 64 MiB. |
| `NOOSPHERE_PROJECTS_PER_OWNER` | No | unlimited | `100` | Per-owner project quota (postgres only). |

### docker-compose-only bootstrap variables

`deploy/docker-compose.yml` also reads `POSTGRES_USER`, `POSTGRES_PASSWORD`, and
`POSTGRES_DB` to initialise the bundled `db` service. Keep them consistent with
`DATABASE_URL`. They are irrelevant when you use a managed database.

## Security considerations

- **No secrets in the repo.** Only `*.example` templates are tracked;
  `deploy/noosphere.env` and `deploy/**/*.env` are git-ignored. The systemd
  `EnvironmentFile` should be `0600`, owned by the service user.
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
| `config-requires:<KEY>` | A required variable is missing/empty (includes `NOOSPHERE_AUTHORIZATION_SERVERS` and `DATABASE_URL` under production). |
| `config-requires-oidc-issuers` / `config-invalid-oidc-issuers-json` | `NOOSPHERE_OIDC_ISSUERS` is empty or not valid JSON. |
| `config-jwks-uri-requires-https` | A `jwks_uri` is not https. |
| `production-requires-postgres-repository` | `NOOSPHERE_PRODUCTION=true` with `NOOSPHERE_REPOSITORY=memory`. |
| `config-invalid-port` / `config-invalid-max-body-bytes` / `config-invalid-projects-per-owner` | Numeric value out of range. |
