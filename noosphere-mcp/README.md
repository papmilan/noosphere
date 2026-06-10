# Noosphere continuity

Noosphere combines open filesystem, CLI, HTTP, and MCP interfaces with a local
continuity daemon. The daemon makes cross-tool handoff independent of vendor
or whether an agent remembers to call an MCP tool.

## What happens while you work

1. The daemon fingerprints the real Git diff and untracked-file state.
2. After eight quiet seconds, it stores a workspace checkpoint.
3. Every twenty seconds, it recalls shared project memory.
4. It atomically refreshes `.noosphere/context.md`.
5. Any tool can read the file directly, print it through the CLI, fetch it over
   HTTP, or recall it through MCP.

The next agent sees the current files locally and receives the cross-session
history through the shared context file.

## Install in a project

From the project root, using this repository checkout:

```sh
node /absolute/path/to/noosphere-mcp/continuity/index.js init
node /absolute/path/to/noosphere-mcp/continuity/index.js watch
```

Inside the Noosphere repository itself:

```sh
npm --prefix noosphere-mcp run continuity:init
npm --prefix noosphere-mcp run continuity:watch
```

Initialization creates:

- `.noosphere.json`
- `.mcp.json` for Claude Code and compatible clients
- `.cursor/mcp.json`
- `.cursor/rules/noosphere.mdc`
- managed Noosphere sections in `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md`

The MCP configs invoke the official package:

```sh
npx -y @mysten-incubation/memwal-mcp@0.0.4 \
  --staging \
  --namespace noosphere-<project>
```

## Privacy default

Automatic checkpoints contain:

- changed file paths;
- branch and commit;
- Git diff statistics;
- timestamp.

Raw source diffs are not uploaded. Set `privacy.include_diff` to `true` in
`.noosphere.json` only when the project is safe to send through the configured
Walrus Memory relayer.

Walrus Memory encrypts blobs for storage, but its managed relayer processes
plaintext for embedding and encryption. Use its manual or self-hosted flow
when that trust boundary is unacceptable.

## Commands

```sh
node continuity/index.js init
node continuity/index.js watch
node continuity/index.js checkpoint
node continuity/index.js refresh
node continuity/index.js status
```

The Claude Code SessionEnd hook remains available for richer reasoning
summaries. File checkpoints preserve work state; the hook preserves intent.

Agents should never be asked to reveal hidden chain-of-thought. The public
work journal captures only conclusions, evidence, attempted approaches, and
next steps.
