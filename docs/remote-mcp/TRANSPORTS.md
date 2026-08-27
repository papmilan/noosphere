# Transport overview

Noosphere Project Memory exposes the **same tool surface and core** over two
transports. They differ only in how a client connects, who they are, and where
state lives — the dispatch, envelopes, and error mapping are shared
(`buildProjectMemoryMcpServer`).

## Remote HTTP (Streamable HTTP MCP)

- **Package:** `noosphere-remote-mcp-server`.
- **Who:** multiple users, each authenticated via OIDC; every request maps to an
  owner scope derived from verified `issuer`/`subject` claims.
- **State:** shared PostgreSQL control plane (durable, survives restarts).
- **Endpoint:** `POST /mcp` behind a TLS-terminating reverse proxy, plus
  `/healthz`, `/readyz`, and RFC 9728 metadata.
- **Sessions:** created at `initialize`, bound to the caller's owner scope; a
  token for a different owner cannot drive an existing session.

**Use it when** memory must be shared across machines/agents/users, must persist
centrally, or must be access-controlled per identity.

See [`DEPLOYMENT.md`](DEPLOYMENT.md) and [`OPERATIONS.md`](OPERATIONS.md).

## Local STDIO MCP

- **Package:** `noosphere-local-mcp` (binary `noosphere-local-mcp`).
- **Who:** a single local user. **No HTTP transport, no OIDC, and no transport
  session registry** — one fixed local owner identity. Project Memory's
  `create_session` records remain part of the shared tool surface.
- **State:** owner-only JSON at
  `~/.noosphere/local-mcp/project-memory.json`. The executable loads it on
  startup and atomically replaces it after successful mutations, so state
  survives ordinary host restarts.
- **Lifecycle:** the MCP host (desktop app / editor) launches the process,
  speaks MCP over stdin/stdout, and the process exits when the host closes the
  stream or sends `SIGINT`/`SIGTERM`. **Not a daemon.**

**Use it when** a single developer wants project memory inside one editor/desktop
host without standing up a server, and does not need cross-machine sharing or
multi-user access control. Multiple same-owner processes on one host are
serialized safely; this is not a distributed lock across machines.

### Installing / editor integration

The package currently carries the monorepo development version `0.0.0`. From a
checkout, point the MCP host at its executable directly:

```text
/absolute/path/to/noosphere-local-mcp/bin/noosphere-local-mcp.js
```

Register it with an MCP host by pointing the host's MCP config at the binary,
for example:

```json
{
  "mcpServers": {
    "noosphere-local": {
      "command": "node",
      "args": ["/absolute/path/to/noosphere-local-mcp/bin/noosphere-local-mcp.js"]
    }
  }
}
```

The host starts the process on demand; nothing runs in the background otherwise.

### Local limitations

- One local owner: no multi-user isolation, no authentication.
- Cross-process mutations are serialized through an owner-only lock and reload
  the latest durable file before applying a change. Lock acquisition is bounded
  and fails closed under unresolved contention. A lock whose recorded process
  is proven dead can be recovered; live or unverifiable owners are preserved.
- No network exposure: it must **not** be published as a network service. For
  cross-machine or multi-user sharing, use the Remote HTTP transport instead.

## Choosing a transport

| Need | Transport |
| --- | --- |
| Shared memory across machines / agents / users | Remote HTTP |
| Durable, centrally stored memory | Remote HTTP |
| Durable, owner-local single-host memory | Local STDIO |
| Per-identity access control (OIDC) | Remote HTTP |
| Single developer, one editor, no server | Local STDIO |
| Zero-infrastructure quick start | Local STDIO |
