# Remote Project Memory Architecture

## Boundary

Remote Project Memory is a new, higher-level continuity layer. It is separate
from CSP v1 and ACP, both of which retain their existing repository-oriented
semantics.

```text
MCP client
  -> Streamable HTTP MCP endpoint (later PR 4)
  -> OAuth/OIDC request context (later PR 3)
  -> Project Memory service (later PR 2)
  -> owner-scoped storage port
  -> PostgreSQL adapter (later PR 3)
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
| Project metadata | PostgreSQL | names, aliases, lifecycle, timestamps |
| Session metadata | PostgreSQL | client/model attribution and state |
| Checkpoint | PostgreSQL | bounded user-visible continuity state |
| Authentication | external OIDC + validated request context | issuer/audience/subject/scope |
| Artifacts/transcripts | not implemented | excluded from v1 |

## Deployment boundary

The reference production deployment will use HTTPS, a Streamable HTTP MCP
endpoint, externally managed OAuth/OIDC, PostgreSQL, and an EU-region runtime.
Region selection alone does not establish legal or regulatory compliance.
PR 1 does not include infrastructure, a container, migrations, or an endpoint.

