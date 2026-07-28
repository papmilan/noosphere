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
├── state.json           Git-tracked canonical CSP project state
├── runtime-state.json   Ignored runtime observations and watcher telemetry
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
noosphere state set status in-progress
noosphere state next "Run tests"
noosphere acp state
noosphere acp state validate
noosphere handoff --file handoff.json
noosphere exec checkpoint --file checkpoint.json
noosphere exec show
noosphere uninstall
```

`noosphere activate` may also be used explicitly from an IDE terminal. It
works from any nested folder inside the repository.

## Owner authority commands (SEC-05 Phase 4C)

These are the only commands that can change which bytes agents treat as
authoritative instructions, and the only commands that can write a project file
from remote memory. Everything here is owner-driven; nothing runs on your
behalf.

```text
noosphere trust migrate
noosphere trust approve  master-prompt|instructions|baseline
noosphere trust revoke   master-prompt|instructions|baseline
noosphere restore stage  master-prompt|instructions|baseline
noosphere restore list
noosphere restore show   <candidate-id>
noosphere restore apply  <candidate-id>
noosphere restore recover
```

That list is exhaustive. There is no other command, flag, environment variable,
configuration key, HTTP endpoint, MCP tool, or hook that can approve, revoke,
migrate, stage, apply, or consume authority state.

### What each command does

| Command | Effect | Interactive |
|---|---|---|
| `trust migrate` | Walks every eligible slot from the read-only legacy inventory and asks for a fresh, separate approval for each. Never promotes old state on its own. | yes |
| `trust approve <slot>` | Makes the slot's **exact current bytes** authoritative. Appends generation N+1. | yes |
| `trust revoke <slot>` | Appends an authenticated tombstone at generation N+1. No bytes for that slot are authoritative until a fresh approval, which lands at N+2. | yes |
| `restore stage <slot>` | Fetches a candidate from remote memory and stores it, authenticated, as **untrusted** owner-local state. Changes no project file and no authority state. | yes |
| `restore list` | Lists active candidates. Mutates nothing. | no |
| `restore show <id>` | Shows one candidate's bytes, escaped, plus the rendering an agent would see. Mutates nothing. | no |
| `restore apply <id>` | Replaces the slot's fixed destination file with the candidate's bytes, once. | yes |
| `restore recover` | Completes an apply transaction that a crash left unfinished. Cannot stage, approve, revoke, or start a transaction. | no |

### Fixed destinations

A slot's destination is fixed in code. No argument, config key, or environment
variable can redirect it, and a symlink at the destination is refused rather
than followed.

| Slot | Destination |
|---|---|
| `master-prompt` | `.noosphere/master-prompt.md` |
| `instructions` | `.noosphere/instructions.md` |
| `baseline` | `.noosphere/baseline.md` |

### Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | unexpected defect |
| 2 | usage error — unknown verb, wrong arity, unsupported slot, non-canonical candidate ID |
| 3 | you declined — the confirmation phrase did not match, or input was too long |
| 4 | security refusal — no terminal, unsafe path, failed authentication, stale state, owner intervention required |

Exit 3 and exit 4 both mean nothing was changed. Only exit 0 means the operation
committed.

### Terminal requirement

`trust migrate`, `trust approve`, `trust revoke`, `restore stage`, and
`restore apply` refuse unless **both** stdin and stdout are a terminal. Piped
stdin, redirected stdout, CI runners, and agent-driven shells are refused with
exit 4 before any state is created or read.

`restore list`, `restore show`, and `restore recover` do not require a terminal:
the first two only read, and `recover` only completes transactions that an
authenticated journal already committed to.

There is **no** `--yes`, `--force`, `--non-interactive`, or `--batch` flag; no
environment variable that skips a confirmation; no configuration key that grants
authority; no HTTP API, MCP tool, hook, adapter, lifecycle service, or package
export that reaches any of these operations. The package exports exactly one
module (`noosphere-continuity/trust-store`) and it can only answer whether bytes
are already authoritative — it can never make them so.

Read the **PTY relay residual** below before relying on the terminal check.

### Candidate lifecycle

Staged candidates are retained for **seven days**, then expire. Retention is
storage, not permission: an active candidate is untrusted the entire time. Nor
does expiry act — retention never approves, applies, revokes, or consumes
anything, and an expired candidate is simply no longer offered.

Candidates and confirmations are **one-shot**:

- Applying a candidate consumes it. The same candidate can never be applied
  twice, whether the outcome was success or failure.
- Each apply issues one confirmation context bound to that exact candidate,
  payload, destination observation, and transaction. It is spent by the first
  answer, right or wrong, and cannot be replayed, rolled back, or rebound to
  another candidate.

**Restaging is required after any failed apply.** A refused, declined, or
crashed apply consumes the candidate; run `restore stage <slot>` again to get a
fresh one.

### Applying into a revoked slot

`restore apply` works on a revoked slot. It replaces the destination file and
leaves the tombstone untouched — the restored bytes are **not** authoritative.
Authority is never implied by a restore: it is recomputed from the live bytes
and the current manifest afterwards, and it comes out true only when those exact
bytes are already the current approved generation. In every other case the CLI
says the bytes remain untrusted and points you at `noosphere trust approve`.

### Crash recovery

If a process dies mid-apply, the transaction is resolved before anything else
can touch that slot:

- Every `restore apply` runs recovery first, before the confirmation prompt and
  before any new transaction exists.
- `noosphere restore recover` runs the same pass on demand.

Recovery is driven entirely by the authenticated apply journal, never by what
the destination file currently contains. **A destination is never replaced
twice.** A transaction that had already committed its replacement converges by
finishing its receipt and consumed marker; one that had not converges by
discarding its temporary file and marking the candidate failed.

A crash leaves the slot lock held. Recovery reclaims that lock only when it can
prove the lock is this project's own, for this transaction, under this owner
scope and machine key — and that the process that wrote it is gone, either
because the lock predates the machine's current boot or because the PID no
longer exists. **A lock is never reclaimed because it is old.** A lock held by a
live process, a malformed lock, a lock whose MAC does not verify, a lock from
another project or owner, and a lock whose ownership cannot be proven are all
left exactly as found.

#### Owner intervention required

Recovery exits 4 with `ERR_RESTORE_OWNER_INTERVENTION_REQUIRED` and changes
nothing when the evidence conflicts. The most important case:

> **The destination changed after the replacement committed.** Recovery will not
> touch it. Your file is left exactly as it is; inspect it and decide yourself.

The same outcome covers a temporary file that does not match the authenticated
payload, an unusable or unprovable lock, a candidate or confirmation that does
not match its journal, and any unauthenticated record. In all of them nothing is
repaired and nothing is deleted.

### Refused sources

An authority-capable slot must be an ordinary, readable, valid-UTF-8 file within
the repository. These are refused rather than degraded, read through, or
silently treated as empty:

| Refused | Why |
|---|---|
| symlinked slot file | the target could be outside the repository or swapped after the check |
| FIFO, device, socket | reading can block forever or return attacker-chosen bytes |
| directory in place of the file | not a slot source |
| malformed UTF-8 | refused before confirmation rather than decoded with replacement characters |
| larger than 1 MiB | refused before it is read or allocated |
| empty | there is nothing to approve; an empty approval would authorize nothing while burning a generation |

A symlinked *parent directory* is supported. The distinction is deliberate: the
slot file itself must be real.

### Windows

Owner-only state uses exact SID DACLs, and a replacement preserves a protected
DACL rather than inheriting a weaker one. When another process holds the
destination or a state file open, Windows reports a sharing violation instead of
allowing the replace; the operation retries within a bounded budget and then
fails closed with exit 4. It never falls back to a truncating write, and it
never leaves a partially written destination. Reparse points on a slot path are
refused, matching the symlink rule above.

### Accepted residual: PTY relay

The terminal requirement blocks piped, redirected, and scripted approval. It is
**not** proof that a human is present. An adversary who can already run commands
as you can allocate a pseudo-terminal, read the displayed bytes, compute the
confirmation phrase, and answer it.

This is accepted, not overlooked. The boundary Phase 4C enforces is that
authority requires an interactive owner session on your machine — not that your
machine is uncompromised. If an attacker has code execution as you, they can
already edit the files these commands approve. See `SECURITY.md` for the full
statement.

### Continuation State Protocol (CSP)

`.noosphere/state.json` is the optional Git-tracked CSP v1 snapshot. It keeps
only durable project truth: version, status, task, next action, and blocker.
Agent identity, observed branch/HEAD, timestamps, revision, and watcher
telemetry remain in ignored `.noosphere/runtime-state.json`. Only explicit
meaningful task transitions rewrite tracked CSP; resume, checkpoint, and
journal operations do not. Ambiguous concurrent edits fail without writing.
See the normative
  [CSP specification](CSP.md) for schema, migration, state-machine, merge, and
compatibility guarantees.

Pre-CSP watcher telemetry is migrated without loss to the ignored
`.noosphere/runtime-state.json`. A conflicting or ambiguous migration fails
closed and leaves both files untouched.

### Agent handoff (ACP)

`noosphere acp state` prints rich ACP truth — objective, decisions, evidence,
blockers, next actions — and `noosphere handoff` merges a structured handoff
from `--file <path>` or `--stdin` without ever silently overwriting prior
work. `noosphere exec checkpoint` records what an agent was about to do, and
`noosphere exec show` re-validates it before the next agent resumes. The CLI
measures repository facts and file hashes itself, so a checkpoint cannot
claim tests pass or carry code to the next agent. `noosphere acp state sync`
extends the same state across machines.

Protocol semantics — validation rules, freshness classification, kernel
budgets, and exact-sync requirements — live in [docs/ACP.md](../docs/ACP.md).

The Claude Code SessionEnd hook remains available for richer reasoning
summaries. File checkpoints preserve work state; the hook preserves intent.

Agents should never be asked to reveal hidden chain-of-thought. The public
work journal captures only conclusions, evidence, attempted approaches, and
next steps.
