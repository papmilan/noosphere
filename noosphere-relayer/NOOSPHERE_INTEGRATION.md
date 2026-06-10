# Noosphere integration

## Preferred: official Walrus Memory MCP

Use the official MCP server for any MCP-compatible CLI, IDE, or agent:

```sh
npx -y @mysten-incubation/memwal-mcp@0.0.4 \
  --staging \
  --namespace noosphere
```

Call `memwal_login` once, `memwal_recall` when starting work, and
`memwal_remember` for decisions and handoffs.

## Automatic continuity

Initialize and keep the watcher running from the project root:

```sh
npm --prefix noosphere-mcp run continuity:init
npm --prefix noosphere-mcp run continuity:watch
```

The watcher stores each settled Git working-tree state and refreshes
`.noosphere/context.md`. Generated instructions make supported agents read the
same context file before working.

Tools without MCP can use:

- `.noosphere/context.md` and `.noosphere/journal.md`;
- the `noosphere` CLI commands;
- `GET /v1/projects/:project_id/bootstrap`;
- the JSON remember and recall HTTP endpoints.

Noosphere asks agents for concise public rationale and handoff notes. It does
not request or store hidden chain-of-thought.

The default `metadata-only` privacy mode uploads changed file paths and diff
statistics, not raw source. Set `privacy.include_diff` only for projects where
the managed relayer trust boundary is acceptable.

## HTTP compatibility API

Noosphere keeps a small HTTP API for applications that want structured records
and automatic evaluation.

### Remember an action

```http
POST /v1/actions
Content-Type: application/json

{
  "project_id": "my-project",
  "agent_id": "codex",
  "action_type": "decision",
  "content": "Use the official Walrus Memory SDK.",
  "model": "codex"
}
```

`score_delta` is ignored if supplied. External evaluation is disabled by
default. Set `SCORING_MODE=remote` and configure `ANTHROPIC_API_KEY` to opt in.

### Recall relevant memory

```http
POST /v1/projects/my-project/recall
Content-Type: application/json

{
  "query": "What storage architecture did we choose?",
  "limit": 10
}
```

### Get prompt-ready context

```http
GET /v1/projects/my-project/context?q=authentication%20decisions&format=text
```

Context is semantic and query-dependent. It is intentionally not a full
project dump.
