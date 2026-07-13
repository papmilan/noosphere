# Noosphere deployment

Noosphere is designed primarily as a single-user local companion service. The
default listener is `127.0.0.1:3001`, and local project-management endpoints
are unavailable to non-loopback clients.

## Local installation

Run the user installer once:

```sh
npm --prefix noosphere-mcp run install:user
~/.noosphere/bin/noosphere setup
```

The installer configures a per-user background relayer and project manager.
Run `noosphere doctor` after installation or credential rotation.

## Public HTTP deployment

Public deployment is optional. Set all of the following:

```env
NODE_ENV=production
HOST=0.0.0.0
NOOSPHERE_API_TOKEN=<random 32-byte or longer token>
CORS_ORIGINS=https://noosphere.example
TRUST_PROXY=1
```

The built-in durable queue and idempotency receipts use one local state file.
The rate limiter is also process-local. Therefore, the current release supports
one relayer instance, not active-active multi-instance deployment. A shared
queue, receipt store, and rate limiter would be required before horizontal
scaling.

## Exact-state deployment modes

Cross-machine exact synchronization requires every client to use the same
durable relayer index. Sharing Walrus credentials alone is not sufficient.
"walrus-backed/relayer-indexed" means Walrus replicates bytes while exact
lookup and heads still depend on that relayer index.

The supported modes are local-only (one-host durability), shared-relayer (one
reachable deployment with durable state and snapshot volumes), and
walrus-backed/relayer-indexed (Walrus exact bytes plus a mandatory durable
relayer index). Clients pin the capability response's `relayer_index_id`.
Restoring only bytes or credentials does not restore heads, ancestry, receipts,
or CAS state. This release is not active-active.

Confirmations are client-local, single-use, and expire within five minutes.
Keep clocks synchronized. Configure durable `NOOSPHERE_STATE_PATH` and
`NOOSPHERE_SNAPSHOT_PATH` volumes together; set
`NOOSPHERE_SHARED_RELAYER=true` only when the topology is truly shared.

### Caddy

```caddyfile
noosphere.example {
    reverse_proxy 127.0.0.1:3001
}
```

### NGINX

```nginx
server {
    listen 443 ssl;
    server_name noosphere.example;

    ssl_certificate /etc/letsencrypt/live/noosphere.example/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/noosphere.example/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Use `/health` for process liveness and `/ready` for Walrus account, delegate,
managed-relayer, and durable-state readiness.

## Backup and recovery

Back up:

- `~/.noosphere/projects.json`
- each project's `.noosphere/` directory
- the relayer runtime state volume containing `.noosphere-runtime/state.json`
- the exact snapshot volume containing `.noosphere-runtime/snapshots/`

Walrus memories are remote and are not recreated from these files. Protect the
runtime state file because pending uploads temporarily contain plaintext.

Project-side `.noosphere/continuity-sync.json` may temporarily contain an
owner-only canonical envelope queued for retry. Successful uploads remove the
job. Invalid jobs remain for inspection and are never replaced with newer
local state.

Credential material is held in the operating-system credential store when
available. Back up the controlling Sui wallet separately. If a delegate key is
lost, register a replacement delegate and run `noosphere credentials rotate`.
