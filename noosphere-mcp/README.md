# Noosphere continuity

Noosphere combines open filesystem, CLI, HTTP, and MCP interfaces with a local
continuity daemon. The daemon makes cross-tool handoff independent of vendor
or whether an agent remembers to call an MCP tool.

## What happens while you work

1. The daemon fingerprints the real Git diff and untracked-file state.
2. After eight quiet seconds, it stores a workspace checkpoint.
3. Every five minutes, it recalls shared project memory.
4. It atomically refreshes `.noosphere/context.md`.
5. Any tool can read the file directly, print it through the CLI, fetch it over
   HTTP, or recall it through MCP.

The next agent sees the current files locally and receives the cross-session
history through the shared context file.

## Bringing Noosphere to an existing project

Noosphere can join a repository that has been running for months or years:

```sh
cd /path/to/existing-project
noosphere activate
```

On first activation, Noosphere prepares one bounded baseline for every Git
repository before normal automatic checkpoints begin. There is no project-age
or commit-count threshold. The baseline contains:

- total repository age and commit count;
- the current branch, commit, changed paths, and workspace fingerprint;
- tracked-file counts grouped by top-level project area;
- up to 50 recent commit dates, hashes, and subjects.

It does not upload source contents or historical diffs. The local copy is
`.noosphere/baseline.md`; the remote record is stored once as a
`project-baseline` memory. Future agents read that baseline before current
intent, semantic recall, and handoffs.

Create or replace the baseline explicitly when needed:

```sh
noosphere baseline
noosphere baseline --commits 100 --force
```

The history window is capped at 200 commits. Noosphere cannot reconstruct old
chat sessions or undocumented decisions from Git. Add important historical
context with `noosphere remember`, or pin an existing project plan with
`noosphere master-prompt`.

## Pinned project intent

Noosphere distinguishes the original plan from later summaries. A substantial
structured or multi-phase prompt is stored exactly in
`.noosphere/master-prompt.md`, uploaded as a `master-prompt` memory, and pinned
above recalled history. Every later visible prompt, including short messages
such as `continue phase 2` and another full master prompt, is appended exactly
to `.noosphere/followups.jsonl` and uploaded as `user-followup`. Follow-ups
refine intent without rewriting the original.

Claude Code captures the prompt through `UserPromptSubmit`. The
`noosphere ollama` wrapper captures it before calling the local model. The user
installer also adds a managed global Codex instruction, so Codex reads the
master prompt automatically without adding `AGENTS.md` to every project. It
also registers `~/.codex/hooks.json` prompt capture. Review and trust that
user hook once through Codex's `/hooks` screen after installation.

For any other CLI, IDE, HTTP client, or agent host:

```sh
cat master-prompt.md | noosphere master-prompt
noosphere master-prompt
```

Use `--replace` only when the project plan changes intentionally. Set
`privacy.capture_master_prompt` to `false` in `.noosphere/config.json` to
disable automatic capture.

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

For a project opened directly in a GUI IDE, register it explicitly:

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

Run any locally installed Ollama model with automatic shared memory:

```sh
noosphere ollama qwen3-coder
noosphere ollama run minimax-m2 "Continue phase 2"
```

The command injects current project memory before the first response and
stores a concise local-model handoff on exit. Handoffs are marked unverified
until corroborated by project files or a correction record. Use `--no-store`
when the session should remain private.

Initialization creates one project folder:

```text
.noosphere/
├── baseline.md          Optional established-project onboarding snapshot
├── config.json
├── context.md
├── followups.jsonl
├── instructions.md
├── journal.md
├── master-prompt.md
└── protocol.json
```

No vendor files are generated by default. Optional compatibility adapters
point tools back to this shared folder and create only the filenames selected:

```sh
noosphere adapters --only claude
noosphere adapters --only claude,codex,mcp
noosphere adapters --only none
```

Available adapters are `claude`, `codex`, `gemini`, `cursor`, and `mcp`.
The MCP adapters invoke the official package:

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
`.noosphere/config.json` only when the project is safe to send through the
configured Walrus Memory relayer.

The established-project baseline is also metadata-only, but it includes recent
Git commit subjects because those summaries help later agents understand the
project's trajectory. Set `onboarding.auto_baseline` to `false` before first
activation if commit subjects are sensitive.

Automatic master-prompt capture is separate from metadata-only checkpoints.
The complete master prompt and later follow-up prompts are intentionally stored
so future agents retain all phases, constraints, corrections, and additions.
Do not place secrets in agent prompts. The managed Walrus Memory relayer
processes this plaintext before Seal encryption. Disable automatic capture
with `privacy.capture_master_prompt: false` when needed.

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
noosphere baseline
noosphere checkpoint
noosphere refresh
noosphere status
noosphere state
noosphere state --json
noosphere state validate
noosphere handoff --file handoff.json
noosphere uninstall
```

`noosphere activate` may also be used explicitly from an IDE terminal. It
works from any nested folder inside the repository.

### ACP continuity kernel

`noosphere state` renders a deterministic, at-most-1,800-byte continuity kernel
from a local-first ACP project-state envelope. It captures externally shareable
state only — objective, decisions, evidence, assumptions, conflicts, blockers,
risks, and next actions — never hidden reasoning, secrets, or raw chat. The
canonical envelope lives in `.noosphere/continuity.json` and its derived kernel
in `.noosphere/continuity.md`.

`noosphere handoff` merges a structured handoff from `--file <path>` or
`--stdin`. The merge is conservative: a stale update appends only new distinct
assertions, and any change to an existing assertion, contested supersession, or
competing priority-1 action becomes an explicit unresolved conflict rather than
silently overwriting prior work. `noosphere state validate` verifies the
envelope digest, schema, kernel projection, and repository compatibility.

The Claude Code SessionEnd hook remains available for richer reasoning
summaries. File checkpoints preserve work state; the hook preserves intent.

Agents should never be asked to reveal hidden chain-of-thought. The public
work journal captures only conclusions, evidence, attempted approaches, and
next steps.

### ACP exact-state synchronization

Use `noosphere state sync|push|pull|history|quarantine --json` for exact ACP
state. Discovery never applies state. Apply requires a cached single-use
`--confirm-remote <confirmation_id>` that expires within five minutes and binds
the snapshot, repository observation, heads, relayer index, versions, action,
and override. A snapshot ID is not a confirmation. Advanced Git history is
non-authoritative unless `--allow-stale-advanced` is bound at discovery and
apply; its kernel suppresses repository-dependent next actions. Set
`NOOSPHERE_ACP_SYNC=false` to disable remote exact synchronization.

Cross-machine exact synchronization requires every client to use the same
durable relayer index. Sharing Walrus credentials alone is not sufficient.
"walrus-backed/relayer-indexed" means Walrus replicates bytes while exact
lookup and heads still depend on that relayer index.

The capability endpoint identifies three modes: local-only, shared-relayer,
and walrus-backed/relayer-indexed. Handoffs remain local-first: configured
failures retain the original bounded canonical envelope in owner-only retry
metadata. Invalid, foreign, or expired bytes are never applied and may be
placed in owner-only quarantine for explicit operator inspection or deletion.
