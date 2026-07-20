# Remote Project Memory — operations docs

Operational documentation for the multi-user, OIDC-authenticated,
PostgreSQL-backed **Remote Project Memory MCP server**. (For the single-user
local relayer, see [`../DEPLOYMENT.md`](../DEPLOYMENT.md); for the STDIO desktop
transport, see [`TRANSPORTS.md`](TRANSPORTS.md).)

| Guide | What it covers |
| --- | --- |
| [Deployment](DEPLOYMENT.md) | Docker Compose, manual image build, systemd, reverse proxy / TLS, upgrades. |
| [Configuration](CONFIGURATION.md) | Every `NOOSPHERE_*` variable — purpose, required, default, example, security. |
| [Operations](OPERATIONS.md) | Endpoints, logging, diagnosis, backup/restore, migration safety, rollback. |
| [Architecture](ARCHITECTURE.md) | Packages, request path, trust boundaries, state & durability. |
| [Transports](TRANSPORTS.md) | Remote HTTP vs Local STDIO — when to use each. |
| [Release](RELEASE.md) | Versioning, tagging, release/verification checklists, upgrade & breaking-change policy. |

Deployment assets live in [`deploy/`](../../deploy/) and
[`noosphere-remote-mcp-server/Dockerfile`](../../noosphere-remote-mcp-server/Dockerfile).
