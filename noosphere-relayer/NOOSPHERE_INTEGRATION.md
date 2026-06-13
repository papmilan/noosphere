# Noosphere integration

Noosphere gives every AI tool access to the same project memory. Use the
interface that the tool already supports: files, CLI, HTTP, or MCP.

## Files

Agents that can read the repository should start with:

- `.noosphere/context.md` for recalled shared context;
- `.noosphere/master-prompt.md` for exact pinned project intent;
- `.noosphere/followups.jsonl` for exact ordered user follow-ups;
- `.noosphere/journal.md` for concise local handoffs;
- `.noosphere/instructions.md` for the universal working protocol.

## CLI

```sh
noosphere context
noosphere recall "What changed in authentication?"
noosphere remember --agent codex --type decision "Use rotating refresh tokens."
noosphere journal --agent codex "Verified login; logout remains untested."
cat project-plan.md | noosphere master-prompt
```

## Ollama

```sh
noosphere ollama qwen3-coder
noosphere ollama run minimax-m2 "Continue from the latest shared handoff"
```

Noosphere injects recalled project memory through Ollama's local chat API and
stores a concise, explicitly unverified session handoff when the model exits.
Substantial multi-phase prompts are pinned separately so later local models can
resolve instructions such as `continue phase 2` against the original plan.
Every subsequent visible prompt is appended as a follow-up without replacing
the original plan.

## HTTP

When `NOOSPHERE_API_TOKEN` is configured, send:

```http
Authorization: Bearer <token>
```

Store a memory:

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

Recall memory:

```http
POST /v1/projects/my-project/recall
Content-Type: application/json

{
  "query": "What storage architecture did we choose?",
  "limit": 10
}
```

Get prompt-ready context:

```http
GET /v1/projects/my-project/context?q=authentication%20decisions&format=text
```

Bootstrap an HTTP-capable agent:

```http
GET /v1/projects/my-project/bootstrap
```

## MCP

Use the official Walrus Memory MCP server:

```sh
npx -y @mysten-incubation/memwal-mcp@0.0.4 \
  --staging \
  --namespace noosphere-<project>
```

MCP is optional. It accesses the same project memory used by the filesystem,
CLI, and HTTP integrations.

## Automatic continuity

The watcher fingerprints the Git working tree. After settled changes, it
stores a metadata-only checkpoint and refreshes `.noosphere/context.md`.

The default checkpoint contains changed paths, branch and commit information,
diff statistics, and a timestamp. It does not upload raw source diffs unless
`privacy.include_diff` is explicitly enabled.

Noosphere records concise conclusions and handoffs. It does not request hidden
chain-of-thought.
