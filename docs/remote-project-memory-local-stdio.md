# Local STDIO MCP mode

Noosphere Project Memory ships two MCP transports over **one** application core.
The tool surface — names, input schemas, behavior, error codes, warning codes,
trust labels, and result envelopes — is identical between them. Only the
transport and the identity model differ.

| | **Remote** (production) | **Local STDIO** (desktop) |
|---|---|---|
| Transport | Streamable HTTP | STDIO (stdin/stdout) |
| Package | `noosphere-remote-mcp-server` | `noosphere-local-mcp` |
| Auth | OAuth 2.1 / OIDC, verified per request | none |
| Users | multi-user (owner scope per verified identity) | single-user (one fixed local owner) |
| Process | long-lived server | launched by the MCP host, exits with it |
| Backend | in-memory or PostgreSQL | in-memory (PR7) |

Both transports build the same MCP server through the shared factory
`buildProjectMemoryMcpServer` in `noosphere-remote-mcp-server/src/mcp-core.js`.
There is **no** duplicated tool logic: the transport is the only major
difference.

## What Local STDIO is

A small executable, `noosphere-local-mcp`, that an MCP host (e.g. a desktop
client) launches as a child process. It speaks MCP over stdin/stdout, serves the
15 Project Memory tools against an in-memory repository, and exits cleanly when
the host closes the stream or sends `SIGINT`/`SIGTERM`. There is no daemon, no
background process, no network listener, and no OIDC.

## How it differs from Remote

- **No authentication.** Local mode does not verify identities. Every request
  runs as one fixed local owner (`LocalOwnerIdentity`), whose scope is a
  constant, namespaced `local:<hash>`. That scope is never derived from tool
  input, so a caller cannot spoof a different identity through arguments, and it
  can never collide with a remote `issuer:…|subject:…` scope.
- **Single-user.** There is exactly one owner; there is no cross-user isolation
  to enforce because there is no second user. Everything created belongs to that
  one local owner.
- **Process-scoped.** State lives in memory for the lifetime of the process.
  When the host disconnects, the process exits and the state is gone (PR7 uses
  the in-memory repository only — no persistence).

This does **not** weaken the Remote security model. Remote continues to require
a verified OIDC identity for every request and never accepts a `local:` scope.

## When to use each

- **Remote** is the production, multi-user deployment: shared server, verified
  identities, optional PostgreSQL persistence.
- **Local STDIO** is for local desktop usage: a single user on one machine whose
  MCP host launches the server as a subprocess. Use it when you want Project
  Memory tools without standing up a server or an identity provider.

## Configuration

The executable takes no required arguments, reads no config file, and has no
environment or CLI override of any kind. It always uses the real system clock.

```
noosphere-local-mcp
```

The server factory (`createLocalStdioServer`) accepts an injected `now` for
determinism, but that seam is used **only** by a test-only fixture launcher
(`tests/fixtures/stdio-fixed-clock.js`); it is never part of the published
package or the production CLI.

### Example MCP host configuration

Most MCP hosts describe a STDIO server by the command to spawn:

```json
{
  "mcpServers": {
    "noosphere-local": {
      "command": "noosphere-local-mcp"
    }
  }
}
```

Or, running from a checkout without a global install:

```json
{
  "mcpServers": {
    "noosphere-local": {
      "command": "node",
      "args": ["/path/to/noosphere-local-mcp/bin/noosphere-local-mcp.js"]
    }
  }
}
```

## Guarantees proven in CI

The `noosphere-local-mcp` acceptance suite proves, against the real transports:

- **Transport parity** — the SDK STDIO client and the Remote HTTP client produce
  byte-identical semantics across the full workflow (initialize, tool discovery,
  tool schemas, project create/resolve/search, session, checkpoint lifecycle,
  listing/retrieval, resume, idempotent replay, conflicting-key reuse, ambiguity,
  cursor pagination, invalid arguments, warning/freshness, trust labels).
  Normalization is limited to generated ids and timestamps.
- **Single-user identity** — deterministic, namespaced scope; input cannot
  override it.
- **Clean lifecycle** — the process exits with code 0 on stdin close and on
  `SIGTERM`, with no hang and no leaked handles.

## Out of scope for PR7

Transport parity only. **Not** included: SQLite / filesystem persistence /
embedded databases, deployment / Docker / systemd / containers, any OAuth/OIDC
change, new tools or APIs, new business logic, multi-process synchronization,
and PR6 deployment work. A persistent local backend is possible future work, not
part of this PR.
