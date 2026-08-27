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
| Backend | PostgreSQL in production; in-memory only for development/tests | owner-only JSON file |

Both transports build the same MCP server through the shared factory
`buildProjectMemoryMcpServer` in `noosphere-remote-mcp-server/src/mcp-core.js`.
There is **no** duplicated tool logic: the transport is the only major
difference.

## What Local STDIO is

A small executable, `noosphere-local-mcp`, that an MCP host (e.g. a desktop
client) launches as a child process. It speaks MCP over stdin/stdout, serves the
16 Project Memory tools against a durable file repository, and exits cleanly
when the host closes the stream or sends `SIGINT`/`SIGTERM`. There is no daemon,
no background process, no network listener, and no OIDC.

## How it differs from Remote

- **No authentication.** Local mode does not verify identities. Every request
  runs as one fixed local owner (`LocalOwnerIdentity`), whose scope is a
  constant, namespaced `local:<hash>`. That scope is never derived from tool
  input, so a caller cannot spoof a different identity through arguments, and it
  can never collide with a remote `issuer:…|subject:…` scope.
- **Single-user.** There is exactly one owner; there is no cross-user isolation
  to enforce because there is no second user. Everything created belongs to that
  one local owner.
- **Owner-local persistence.** The executable loads
  `~/.noosphere/local-mcp/project-memory.json` at startup and atomically writes
  an owner-only snapshot after each successful mutation. A corrupt or unsafe
  store fails startup closed instead of silently starting empty.
- **Cross-process serialization.** Each mutation takes an owner-only lock,
  reloads the latest durable snapshot under that lock, then atomically commits.
  Reads refresh from disk. Independent MCP hosts therefore cannot silently
  overwrite one another's committed changes. A later writer reclaims a lock
  only after verifying that its recorded process is dead; unsafe or
  unverifiable lock state fails closed.

This does **not** weaken the Remote security model. Remote continues to require
a verified OIDC identity for every request and never accepts a `local:` scope.

## When to use each

- **Remote** is the production, multi-user deployment: shared server, verified
  identities, and PostgreSQL persistence.
- **Local STDIO** is for local desktop usage: a single user on one machine whose
  MCP host launches the server as a subprocess. Use it when you want durable
  owner-local Project Memory without standing up a server or identity provider.

## Configuration

The executable takes no arguments, reads no config file, and has no environment
or CLI override. It always uses the real system clock and the fixed owner-local
state path `~/.noosphere/local-mcp/project-memory.json`.

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
- **Persistence** — projects, sessions, checkpoints, checkpoint lineage, and
  idempotency receipts survive process restart; unsafe paths and corrupt
  snapshots fail closed.
- **Mutation rollback** — an atomic-write failure rejects the operation and
  restores the prior in-process snapshot, so a failed persistence response does
  not leave visible memory ahead of disk.
- **Concurrent-host safety** — deterministic two-host tests force overlapping
  mutations and prove both commits remain durable and visible after restart.
- **Clean lifecycle** — the process exits with code 0 on stdin close and on
  `SIGTERM`, with no hang and no leaked handles.

## Out of scope

Not included: SQLite or another embedded database, deployment / Docker /
systemd / containers, OAuth/OIDC, network exposure, multi-user isolation, or
distributed locking across machines. The file repository is deliberately an
owner-local desktop store; unresolved local lock contention fails closed after
a bounded wait. Dead recorded owners are recovered automatically; ambiguous,
malformed, symlinked, or live-owner locks are not removed speculatively.
