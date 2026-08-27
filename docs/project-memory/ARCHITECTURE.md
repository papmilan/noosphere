# Remote Project Memory Architecture

## Boundary

Project Memory is a higher-level continuity layer. It is separate from CSP v1
and ACP, both of which retain their repository-oriented semantics.

```text
MCP client
  -> Remote Streamable HTTP -> OAuth/OIDC owner scope -> PostgreSQL
   or Local STDIO          -> fixed local owner      -> owner-only JSON file
  -> shared MCP tool builder
  -> Project Memory service
  -> owner-scoped repository port
```

The remote process cannot read the user's local filesystem and has no access to
unsubmitted client conversation state. There is no server-global current
project. A client resolves a project, asks the user when matches are ambiguous,
then uses that exact project ID.

## Durable persistence boundary

Noosphere resumes only data that a prior client successfully persisted. It
cannot recover an unsaved chat, hidden model reasoning, model-private context,
an interrupted output with no checkpoint, expired context-window content, or
data the client never sent.

A session may be newer than its latest checkpoint. `resume_project` reports
that state as incomplete; it never presents the checkpoint as a final handoff.

## Data classes

| Class | Storage | v1 content |
| --- | --- | --- |
| Project metadata | PostgreSQL or Local STDIO file | names, aliases, lifecycle, timestamps |
| Session metadata | PostgreSQL or Local STDIO file | client/model attribution and state |
| Checkpoint | PostgreSQL or Local STDIO file | bounded user-visible continuity state |
| Authentication | external OIDC + validated request context | issuer/audience/subject/scope |
| Artifacts/transcripts | not implemented | excluded from v1 |

## Deployment boundary

The reference production deployment uses HTTPS terminated by a reverse proxy,
a Streamable HTTP MCP endpoint, externally managed OAuth/OIDC, and PostgreSQL.
The repository includes a container, Docker Compose reference, systemd unit,
and forward-only migrations under `deploy/` and
`noosphere-remote-mcp-postgres/`. Region selection alone does not establish
legal or regulatory compliance. See [`../remote-mcp/`](../remote-mcp/README.md)
for the operator contract.
