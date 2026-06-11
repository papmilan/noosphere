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

## Install once on macOS

From this repository:

```sh
npm --prefix noosphere-mcp run install:user
```

The installer:

- installs the `noosphere` command under `~/.noosphere/bin`;
- copies the relayer and continuity runtime into `~/.noosphere/app`;
- installs a relayer LaunchAgent that starts at login and stays running;
- installs a project-manager LaunchAgent that manages every watcher;
- adds a small zsh directory hook.

When a new terminal enters a Git repository, the hook runs
`noosphere activate --quiet`. The command discovers the repository root,
initializes Noosphere if needed, and registers it with the project manager.
Create `.noosphere-ignore` in a repository to prevent automatic activation.
`noosphere deactivate` unregisters a project from the background manager.

Existing terminals load the integration after:

```sh
source ~/.zshrc
```

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
noosphere doctor
noosphere activate
noosphere deactivate
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
