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

## Install once

From this repository:

```sh
npm --prefix noosphere-mcp run install:user
~/.noosphere/bin/noosphere setup
```

The installer supports macOS, Linux, and Windows. It:

- installs the `noosphere` command under `~/.noosphere/bin`;
- copies the relayer and continuity runtime into `~/.noosphere/app`;
- installs per-user relayer and project-manager background services;
- adds activation hooks for zsh, bash, fish, and PowerShell.

When a terminal enters a Git repository, the hook runs
`noosphere activate --quiet`. The command discovers the repository root,
initializes Noosphere if needed, and registers it with the project manager.
Create `.noosphere-ignore` in a repository to prevent automatic activation.
`noosphere deactivate` unregisters a project from the background manager.

For a project opened directly in a GUI IDE, add it from the local dashboard at
`http://127.0.0.1:3001/#projects` or use:

```sh
noosphere register --path /absolute/path/to/repository
```

Noosphere does not scan the whole computer. Registration is explicit, honors
`.noosphere-ignore`, canonicalizes symlinks, and produces only one watcher per
physical repository.

Credential commands:

```sh
noosphere setup
noosphere credentials status
noosphere credentials migrate
noosphere credentials rotate
```

Setup validates the account and registered delegate on Sui before storage.
Its optional smoke test performs a real Walrus store and semantic recall.

Initialization creates:

- `.noosphere.json`
- `.mcp.json` using the open Model Context Protocol
- `.noosphere/context.md`
- `.noosphere/journal.md`
- `.noosphere/protocol.json`
- `NOOSPHERE.md`

It also creates small compatibility adapters for tools that support automatic
project instructions. These adapters do not contain separate memory or logic;
they only point the tool back to the universal protocol and shared files:

- `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md`;
- `.cursor/mcp.json` and `.cursor/rules/noosphere.mdc`.

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
noosphere install
noosphere setup
noosphere credentials status
noosphere doctor
noosphere activate
noosphere deactivate
noosphere register --path /absolute/path/to/repository
noosphere projects
noosphere checkpoint
noosphere refresh
noosphere status
noosphere uninstall
```

`noosphere activate` may also be used explicitly from an IDE terminal. It
works from any nested folder inside the repository.

The Claude Code SessionEnd hook remains available for richer reasoning
summaries. File checkpoints preserve work state; the hook preserves intent.

Agents should never be asked to reveal hidden chain-of-thought. The public
work journal captures only conclusions, evidence, attempted approaches, and
next steps.
