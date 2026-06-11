# Noosphere

The shared mind for AI agents.

Noosphere gives AI agents a common project memory that survives switches
between CLIs, IDEs, models, and sessions. An agent can store a decision once,
and another agent can retrieve it later through files, CLI commands, HTTP, or
the Model Context Protocol.

Noosphere is built on
[Walrus Memory](https://docs.wal.app/walrus-memory/getting-started/what-is-walrus-memory)
for encrypted storage and semantic recall.

## What it provides

- A portable format for decisions, findings, code changes, and handoffs
- Automatic checkpoints when the working tree changes
- A refreshed project context file for tools without MCP support
- Semantic recall instead of repeatedly loading an entire project history
- Optional, privacy-aware output evaluation
- HTTP and browser interfaces for universal compatibility
- Configuration for the official Walrus Memory MCP server

## Architecture

```text
AI agent, CLI, IDE, or web UI
              |
              v
     Noosphere memory record
              |
              v
 Official Walrus Memory SDK / MCP
              |
              +-- Seal encryption
              +-- Walrus blob storage
              +-- Semantic indexing and recall
              +-- Sui account ownership and delegate permissions
```

Walrus stores the encrypted project memories. Sui provides ownership and
delegate access control through Walrus Memory. Noosphere does not require a
custom smart contract.

Optional AI evaluations are stored as inspectable metadata beside a memory.
They are not presented as trustless consensus or immutable on-chain
reputation.

## Run locally

Requirements:

- Node.js 20 or newer
- npm

Install and start the local demo:

```sh
cd noosphere-relayer
npm install
npm run demo
```

Open [http://127.0.0.1:3001](http://127.0.0.1:3001).

Demo mode uses a gitignored local persistence file. To connect Walrus Memory:

1. Copy `noosphere-relayer/.env.example` to
   `noosphere-relayer/.env`.
2. Create delegate credentials in the
   [Walrus Memory dashboard](https://memory.walrus.xyz/).
3. Set `MEMWAL_PRIVATE_KEY` and `MEMWAL_ACCOUNT_ID`.
4. Set `DEMO_MODE=false`.

## Enable continuity

Initialize Noosphere in a project and start the watcher:

```sh
npm --prefix noosphere-mcp run continuity:init
npm --prefix noosphere-mcp run continuity:watch
```

The watcher fingerprints the Git working tree. After eight quiet seconds, it
stores a metadata-only checkpoint. It also refreshes
`.noosphere/context.md` every twenty seconds so the next agent can continue
from the latest shared state.

Keep the watcher running while supported CLIs or IDEs edit the workspace.

## Connect agents

The universal protocol is documented in `NOOSPHERE.md`. Agents can use:

- `.noosphere/context.md` for current shared context
- `.noosphere/journal.md` for concise decisions and handoffs
- `noosphere context`, `recall`, `remember`, and `journal` CLI commands
- `POST /v1/actions` to store memory
- `POST /v1/projects/:project_id/recall` for semantic recall
- `GET /v1/projects/:project_id/bootstrap` for prompt-ready instructions
- The official Walrus Memory MCP server

Example MCP command:

```sh
npx -y @mysten-incubation/memwal-mcp@0.0.4 \
  --staging \
  --namespace noosphere-<project>
```

Small adapters for Claude, Cursor, Codex, Gemini, and other tools only point
back to the same universal protocol. They do not create separate memory
systems.

## Privacy

Automatic checkpoints contain changed paths, the current branch and commit,
diff statistics, and a timestamp. Raw source diffs are not uploaded by
default.

Noosphere never asks agents to reveal hidden chain-of-thought. Agents record
short, externally understandable conclusions, evidence, failed approaches,
and handoffs instead.

Remote output evaluation is disabled by default. Enabling
`SCORING_MODE=remote` sends the action and recalled context to the configured
AI provider.

See `noosphere-relayer/TRUST.md` for the complete trust and privacy model.

## Packages

- `noosphere-relayer`: HTTP API, Walrus Memory adapter, optional evaluation,
  and browser interface
- `noosphere-mcp`: continuity watcher, CLI, universal project integration,
  MCP configuration, and optional Claude session hook

## Verification

```sh
cd noosphere-relayer
npm run check
npm test

cd ../noosphere-mcp
npm run check
```
