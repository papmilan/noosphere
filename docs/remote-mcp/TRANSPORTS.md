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
- **Who:** a single local user. **No HTTP, no OIDC, no sessions** — one fixed
  local owner identity.
- **State:** in-memory repository (PR7). It is **ephemeral**: memory exists only
  for the lifetime of the process and is not persisted across restarts.
- **Lifecycle:** the MCP host (desktop app / editor) launches the process,
  speaks MCP over stdin/stdout, and the process exits when the host closes the
  stream or sends `SIGINT`/`SIGTERM`. **Not a daemon.**

**Use it when** a single developer wants project memory inside one editor/desktop
host without standing up a server, and does not need cross-machine sharing or
durable central storage.

### Installing / editor integration

Install the CLI (from the package directory or once published):

```sh
npm install -g @noosphere/local-mcp    # or run via the package's bin
```

Register it with an MCP host by pointing the host's MCP config at the binary,
for example:

```json
{
  "mcpServers": {
    "noosphere-local": {
      "command": "noosphere-local-mcp",
      "args": []
    }
  }
}
```

The host starts the process on demand; nothing runs in the background otherwise.

### Single-user limitations

- Ephemeral (PR7): restarting the host clears in-process memory.
- One local owner: no multi-user isolation, no authentication.
- No network exposure: it must **not** be published as a network service. For
  sharing or durability, use the Remote HTTP transport instead.

## Choosing a transport

| Need | Transport |
| --- | --- |
| Shared memory across machines / agents / users | Remote HTTP |
| Durable, centrally stored memory | Remote HTTP |
| Per-identity access control (OIDC) | Remote HTTP |
| Single developer, one editor, no server | Local STDIO |
| Zero-infrastructure quick start | Local STDIO |
