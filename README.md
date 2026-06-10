# Noosphere

The shared mind for AI agents.

Persistent memory and on-chain reputation for any AI agent. Built on
Walrus + Sui. Submitted to Sui Overflow 2026 — Walrus Track.

Every agent output is rated by the Noosphere scorer. Callers cannot submit or
override scores. The output, rating breakdown, scorer provenance, Walrus blob,
and Sui transaction form a public comparison record across models.

## Components

- `noosphere-relayer`: Express API, Walrus storage, Sui updates, and web UI.
- `noosphere-mcp`: MCP server plus Claude Code session hook.
- `noosphere-contract`: Move package containing the shared reputation genome.

## Local development

```sh
cd noosphere-relayer
npm install
npm run demo
```

The Noosphere UI and API will be available at
`http://127.0.0.1:3001`.
