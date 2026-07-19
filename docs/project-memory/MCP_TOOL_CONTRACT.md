# Project Memory MCP Tool Contract

This is a contract for a future remote Streamable HTTP MCP server. PR 1 ships no
endpoint. All inputs are deterministic JSON objects; authenticated identity is
derived by the server and is never a tool argument.

## Common rules

- Inputs reject unknown fields.
- Project IDs are opaque and do not authorize access.
- List results use opaque cursors and a maximum page size of 100.
- Stored checkpoint fields returned by read tools include
  `content_trust: "untrusted-persisted-data"`.
- `idempotency_key` is required for `save_checkpoint`; reuse with different
  content returns `idempotency-conflict`.
- An unauthenticated, forbidden, or missing result does not disclose private
  names or existence details.

| Tool | Required input | Result |
| --- | --- | --- |
| `create_project` | name | new project |
| `list_projects` | optional cursor/limit | non-archived projects by default |
| `get_project` | project_id | one project |
| `find_projects` | query | resolved, ambiguous candidates, or none |
| `update_project` | project_id plus changes | updated project |
| `archive_project` | project_id | archived project |
| `create_session` | project_id, source_client | session ID |
| `get_session` | project_id, session_id | one session |
| `list_project_sessions` | project_id, cursor | bounded session page |
| `save_checkpoint` | project_id, checkpoint, idempotency_key | checkpoint ID, revision, deduplication |
| `get_latest_checkpoint` | project_id | latest checkpoint or null |
| `get_checkpoint` | project_id, checkpoint_id | exact checkpoint |
| `list_checkpoints` | project_id, cursor | bounded checkpoint page |
| `resume_project` | project_id | continuation package and freshness warnings |
| `get_project_summary` | project_id | bounded overview |

## Project selection

`find_projects` evaluates exact ID, exact normalized name, aliases, then
bounded text search ordered by latest activity. It returns `ambiguous` when
multiple plausible candidates remain. A client must ask the user to choose;
the server never treats “latest” or a low-confidence text match as authority.

## Resume semantics

`resume_project` returns the matched project, latest durable checkpoint,
goal, current status, facts, assumptions, decisions, unresolved questions,
blockers, next actions, recent sessions, freshness, warnings, and the
untrusted-data label. It never returns a raw database row or claims to recover
unpersisted conversation state.

