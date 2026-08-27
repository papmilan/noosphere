# Remote Project Memory — Deployment guide

This guide covers deploying **Noosphere Remote Project Memory**: the multi-user,
OIDC-authenticated MCP server backed by PostgreSQL. It is a different subsystem
from the single-user local relayer described in [`docs/DEPLOYMENT.md`](../DEPLOYMENT.md).

> This is an **operational** guide for the production composition. For the
> STDIO desktop transport see
> [`TRANSPORTS.md`](TRANSPORTS.md); for every environment variable see
> [`CONFIGURATION.md`](CONFIGURATION.md).

## Components

| Package | Role |
| --- | --- |
| `noosphere-remote-mcp` | Versioned contracts + Project Memory service core (no runtime of its own). |
| `noosphere-remote-mcp-postgres` | PostgreSQL control-plane repository, OIDC verifier, SQL migrations. |
| `noosphere-remote-mcp-server` | Streamable HTTP MCP server + production entrypoint (`src/main.js`). |

All **durable** state lives in PostgreSQL, so restarting or rolling a single
server loses no data. **MCP session state, however, is process-local** — open
sessions are held in the server's memory, not in a shared store (none is
implemented). This has two consequences:

- **Rolling restarts invalidate active sessions.** Clients reconnect; no data is
  lost, but in-flight sessions end.
- **Multiple replicas require session affinity.** Every request carrying a given
  `Mcp-Session-Id` must be routed to the same instance (sticky sessions /
  consistent hashing on that header). Load balancing without affinity will route
  a follow-up request to a replica that has never seen the session and fail it.

Run a single instance unless your load balancer enforces `Mcp-Session-Id`
affinity. Transparent horizontal scaling is **not** currently supported.
All replicas must also receive the same owner-controlled
`NOOSPHERE_CURSOR_SECRET`; session affinity does not make pagination cursors
replica-local, and changing that secret invalidates outstanding cursors.

## Supported deployment models

- **Docker Compose reference stack** — server + PostgreSQL + one-shot migration
  on one host. Start here. (`deploy/docker-compose.yml`)
- **Container + managed PostgreSQL** — run the image, point `DATABASE_URL` at a
  managed database.
- **systemd standalone** — `node src/main.js` under systemd with a managed or
  co-located PostgreSQL. (`deploy/systemd/`)

### Unsupported / out of scope

- Running the production server on the in-memory repository (rejected at
  startup when `NOOSPHERE_PRODUCTION=true`).
- Terminating TLS in the Node process — always front it with a reverse proxy.
- The STDIO transport as a network daemon — it is single-user and local only.

## 1. Docker Compose (recommended reference)

```sh
cp deploy/noosphere.env.example deploy/noosphere.env
# edit deploy/noosphere.env: audience, issuers, CURSOR_SECRET, DATABASE_URL, POSTGRES_* ...
docker compose --env-file deploy/noosphere.env -f deploy/docker-compose.yml up -d
```

> `--env-file deploy/noosphere.env` is required on **every** Compose command for
> this stack. Compose evaluates the `${VAR:?}` guards during interpolation, which
> reads only the `--env-file` (or project-directory `.env`) — not a service's
> `env_file:`. Without it, `db`/`migrate` fail to start with `set … in
> deploy/noosphere.env`. Validate first with:
>
> ```sh
> docker compose --env-file deploy/noosphere.env -f deploy/docker-compose.yml config -q
> ```

The stack:

- **db** — `postgres:16-alpine`, persistent `pgdata` volume, healthchecked,
  reachable only on the internal `backplane` network.
- **migrate** — one-shot; applies pending migrations, then exits. `up` waits for
  it to complete before starting the server.
- **server** — bound to `127.0.0.1:8080` for a reverse proxy to forward to;
  attached to both `edge` and `backplane`; healthchecked; `restart: unless-stopped`.

Verify:

```sh
curl -fsS http://127.0.0.1:8080/healthz   # {"status":"ok"}
curl -fsS http://127.0.0.1:8080/readyz    # {"status":"ready"} once the DB is up
```

## 2. Building the image manually

The build context is the **repository root** (the server composes two sibling
packages):

```sh
node scripts/docker-build.mjs remote-mcp --tag noosphere-remote-mcp-server:latest
```

The helper copies only the three runtime packages into an owner-local temporary
directory, refuses symlinks and non-regular entries, omits dependencies, tests,
secrets, and macOS metadata, invokes BuildKit, and removes the context afterward.
On a native filesystem the equivalent direct command remains:

```sh
docker build -f noosphere-remote-mcp-server/Dockerfile -t noosphere-remote-mcp-server .
```

The image runs as the non-root `node` user (uid 1000), ships no npm CLI, and
declares a `/healthz` HEALTHCHECK.

> macOS note: building from a case-insensitive/exFAT volume that carries
> AppleDouble `._*` files can trip the BuildKit context sender
> (`failed to xattr … operation not permitted`) before `.dockerignore` can
> exclude them. Use `scripts/docker-build.mjs`; disabling BuildKit is deprecated
> and may still hang while constructing the legacy context. For the reference
> stack, run the helper with its default tag and then add `--no-build` to the
> documented Compose `up` command.

## 3. systemd standalone

Deploy the three packages under `/opt/noosphere` with production dependencies
installed (`npm ci --omit=dev` in `noosphere-remote-mcp-server` and
`noosphere-remote-mcp-postgres`), create an unprivileged `noosphere` user, then:

```sh
sudo install -o noosphere -g noosphere -m 0600 \
  deploy/systemd/remote-mcp.env.example /etc/noosphere/remote-mcp.env
sudo $EDITOR /etc/noosphere/remote-mcp.env            # fill in real values
sudo cp deploy/systemd/noosphere-remote-mcp.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now noosphere-remote-mcp
```

Apply migrations before first start and on every upgrade:

```sh
cd /opt/noosphere/noosphere-remote-mcp-postgres
DATABASE_URL=... node migrate.js
```

## 4. Reverse proxy & TLS termination

The server speaks plain HTTP and must sit behind a TLS-terminating reverse
proxy. Forward `/mcp`, `/healthz`, `/readyz`, and
`/.well-known/oauth-protected-resource`.

### NGINX

```nginx
server {
    listen 443 ssl;
    server_name mcp.noosphere.example;

    ssl_certificate     /etc/letsencrypt/live/mcp.noosphere.example/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mcp.noosphere.example/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # Streamable HTTP: don't buffer the response stream.
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}
```

### Caddy

```caddyfile
mcp.noosphere.example {
    reverse_proxy 127.0.0.1:8080
}
```

Point health checks at `/readyz` (gates traffic on database availability) and
liveness at `/healthz` (process only).

## 5. Graceful shutdown & upgrades

`src/main.js` traps `SIGTERM`/`SIGINT`. The server stops accepting sockets,
closes MCP transports concurrently, allows up to five seconds for the HTTP
drain, force-closes remaining connections, then closes the PostgreSQL pool.
Concurrent shutdown signals share the same cleanup operation. Docker
(`docker stop`) and systemd both send `SIGTERM`; retain a supervisor timeout
above the five-second application grace period (the reference service uses
30 seconds).

Upgrade path: apply new migrations (forward-only, advisory-locked), then roll
the server image/version. See [`OPERATIONS.md`](OPERATIONS.md#upgrade-procedure).
