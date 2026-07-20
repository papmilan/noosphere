# Remote Project Memory — Deployment guide

This guide covers deploying **Noosphere Remote Project Memory**: the multi-user,
OIDC-authenticated MCP server backed by PostgreSQL. It is a different subsystem
from the single-user local relayer described in [`docs/DEPLOYMENT.md`](../DEPLOYMENT.md).

> This is an **operational** guide. It changes no protocol, tool schema, or
> business logic — it only describes how to run the software that PR1–PR5/PR7
> already implemented. For the STDIO desktop transport see
> [`TRANSPORTS.md`](TRANSPORTS.md); for every environment variable see
> [`CONFIGURATION.md`](CONFIGURATION.md).

## Components

| Package | Role |
| --- | --- |
| `noosphere-remote-mcp` | Versioned contracts + Project Memory service core (no runtime of its own). |
| `noosphere-remote-mcp-postgres` | PostgreSQL control-plane repository, OIDC verifier, SQL migrations. |
| `noosphere-remote-mcp-server` | Streamable HTTP MCP server + production entrypoint (`src/main.js`). |

The server process is **stateless**: all durable state lives in PostgreSQL, so
it is safe to restart or roll and (subject to a shared database) run more than
one replica behind a load balancer.

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
# edit deploy/noosphere.env: audience, issuers, DATABASE_URL, POSTGRES_* ...
docker compose -f deploy/docker-compose.yml up -d
```

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
docker build -f noosphere-remote-mcp-server/Dockerfile -t noosphere-remote-mcp-server .
```

The image runs as the non-root `node` user (uid 1000), ships no npm CLI, and
declares a `/healthz` HEALTHCHECK.

> macOS note: building from a case-insensitive/exFAT volume that carries
> AppleDouble `._*` files can trip the BuildKit context sender
> (`failed to xattr … operation not permitted`). Build with `DOCKER_BUILDKIT=0`
> or from an ext4/APFS checkout. Linux CI is unaffected.

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

`src/main.js` traps `SIGTERM`/`SIGINT`, drains open MCP sessions, closes the
PostgreSQL pool, and exits 0. Docker (`docker stop`) and systemd both send
`SIGTERM`; allow ~30s before escalation.

Upgrade path: apply new migrations (forward-only, advisory-locked), then roll
the server image/version. See [`OPERATIONS.md`](OPERATIONS.md#upgrade-procedure).
