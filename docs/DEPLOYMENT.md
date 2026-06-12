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

Walrus memories are remote and are not recreated from these files. Protect the
runtime state file because pending uploads temporarily contain plaintext.

Credential material is held in the operating-system credential store when
available. Back up the controlling Sui wallet separately. If a delegate key is
lost, register a replacement delegate and run `noosphere credentials rotate`.
