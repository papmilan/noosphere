# Noosphere

The shared mind for AI agents.

Noosphere is a thin application layer on top of
[Walrus Memory](https://docs.wal.app/walrus-memory/getting-started/what-is-walrus-memory).
It gives any agent, CLI, IDE, or HTTP client a common format for project
decisions, handoffs, and quality evaluations.

## Why version 2 is smaller

The first version maintained its own Move contract, direct Walrus uploader,
local JSON index, Sui transaction layer, and MCP server. Walrus Memory already
provides encrypted storage, semantic indexing, account permissions, restore,
and an official cross-agent MCP server. Rebuilding those pieces added
complexity without adding product value.

Noosphere 2 keeps only what is specific to the product:

- a portable agent-memory record format;
- automatic workspace checkpoints and refreshed cross-agent context;
- privacy-first, optional output evaluation;
- a small HTTP compatibility API;
- a focused remember/recall interface;
- ready-to-use configuration for the official Walrus Memory MCP server.

## Architecture

```text
AI agent or web UI
        |
        v
Noosphere record + optional evaluation
        |
        v
Official Walrus Memory SDK / MCP
        |
        +-- Seal encryption
        +-- Walrus blob storage
        +-- semantic index and recall
        +-- Sui account and delegate permissions
```

Noosphere does not deploy a custom smart contract and does not claim that its
AI-generated evaluations are trustless or immutable. Walrus Memory's Sui
contract is used by the platform for ownership and delegate access.

## Seamless continuity

Run the continuity daemon in a project:

```sh
npm --prefix noosphere-mcp run continuity:init
npm --prefix noosphere-mcp run continuity:watch
```

It checkpoints each settled working-tree change after an eight-second
debounce, then refreshes `.noosphere/context.md` every twenty seconds. Project
instructions and the universal `NOOSPHERE.md` protocol make the same context
available through files, CLI commands, HTTP, and MCP.

Keep the watcher running while any supported CLI or IDE is editing the
workspace.

The default checkpoint contains changed paths and diff statistics, not raw
source code. The current files remain the source of truth when switching tools
inside the same workspace.

Agents also maintain `.noosphere/journal.md` with concise findings, evidence,
decisions, and handoffs. This is not hidden chain-of-thought: it is a short
public rationale another engineer or model can verify.

## Run locally

```sh
cd noosphere-relayer
npm install
npm run demo
```

Open `http://127.0.0.1:3001`.

Demo mode uses a gitignored local persistence file. To use Walrus Memory
staging, copy
`noosphere-relayer/.env.example` to `.env`, set the delegate credentials from
the [Walrus Memory dashboard](https://memory.walrus.xyz/), and set
`DEMO_MODE=false`.

## Connect an agent

The configs in `noosphere-mcp/mcp-server` run the official MCP server:

```sh
npx -y @mysten-incubation/memwal-mcp@0.0.4 \
  --staging \
  --namespace noosphere-<project>
```

The daemon handles routine checkpoints and context refresh automatically.
Agents can still use `memwal_remember` for important reasoning and
`memwal_recall` for focused questions. The official package supports Claude
Desktop, Claude Code, Cursor, Codex, and Antigravity. Other tools can use the
filesystem, CLI, or HTTP interfaces documented in `NOOSPHERE.md`.

## Packages

- `noosphere-relayer`: thin API, evaluation, Walrus Memory adapter, and UI.
- `noosphere-mcp`: continuity daemon, project integration, official MCP
  configuration, and optional Claude hook.
- `noosphere-contract`: retired; no custom Move package is part of version 2.
