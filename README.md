# Noosphere

**Switch AI tools without losing project context.**

Noosphere gives a software project one shared memory that every AI coding tool
can read and update. Work can begin in Codex, continue in Claude Code, move to
Cursor, and finish through another CLI or HTTP client without forcing each
agent to rediscover the project from scratch.

It stores project memories through
[Walrus Memory](https://docs.wal.app/walrus-memory/getting-started/what-is-walrus-memory),
uses semantic recall to retrieve only the relevant history, and exposes the
same memory through files, a CLI, HTTP, and MCP.

## The problem

AI coding tools usually keep context inside one session and one product.

When a session ends or the user switches tools:

- decisions disappear into chat history;
- bugs and failed approaches are investigated again;
- the next agent cannot see what another agent already verified;
- long projects repeatedly spend tokens rebuilding context;
- useful work is tied to a vendor instead of the project.

The repository survives. The agent's understanding often does not.

## The solution

Noosphere attaches memory to the project, not to the AI provider.

```text
Codex finds a bug
       |
       v
Noosphere stores the finding in the project's Walrus namespace
       |
       v
Claude Code, Cursor, Gemini, or another agent recalls it later
       |
       v
The next agent verifies or continues the work instead of starting over
```

In one sentence:

> Noosphere is a continuity layer that lets any AI agent resume a project from
> the work, decisions, findings, and handoffs left by previous agents.

## What happens during normal use

1. You install Noosphere once for your user account.
2. Entering or registering a Git repository gives it a stable project ID.
3. The repository receives one bounded starting baseline.
4. A background watcher observes settled working-tree changes.
5. Noosphere stores metadata-only checkpoints after the workspace is quiet.
6. Agents store explicit decisions, findings, and handoffs when they matter.
7. Walrus Memory indexes those records for semantic recall.
8. `.noosphere/context.md` is refreshed with relevant shared memory.
9. The next tool reads the file, calls the CLI, uses HTTP, or connects through
   MCP.

Noosphere does not capture hidden chain-of-thought. It records concise,
externally understandable facts: what changed, what was decided, what failed,
what was verified, and what should happen next.

## ACP continuity kernel

The Agent Cognitive-state Protocol (ACP) adds a local-first, storage-neutral
project-state envelope on top of the existing memory and journal systems. It
stores only externally shareable state — objective, decisions, evidence,
assumptions, conflicts, blockers, risks, and next actions — never hidden
reasoning, secrets, or raw chat.

```bash
noosphere state              # print the compact continuity kernel
noosphere state --json       # print the canonical ACP envelope
noosphere state validate     # verify the persisted envelope and kernel
cat handoff.json | noosphere handoff --stdin
noosphere handoff --file handoff.json
```

### Exact state across machines

`noosphere state sync|push|pull|history|quarantine --json` uses deterministic
ACP envelopes. Discovery is read-only; apply requires a cached single-use
`--confirm-remote <confirmation_id>`. Confirmations expire within five minutes.
Advanced history requires `--allow-stale-advanced` at discovery and apply and
renders with downgraded authority and suppressed next actions. Set
`NOOSPHERE_ACP_SYNC=false` to disable exact remote synchronization.

### Execution continuity

Project State answers "what is true"; an execution checkpoint answers "what
was I about to do." `noosphere exec checkpoint` records an advisory cursor
over the current Project State snapshot — current step, target file and
symbol, remaining steps, search frontier — while the CLI itself measures
every fact a successor will trust: repository state, per-step file hashes,
and the snapshot binding. Asserted lies are overwritten by measurement, and
the checkpoint can never carry code, diffs, or multi-line payloads.

```bash
noosphere exec checkpoint --file checkpoint.json   # record where work stood
noosphere exec show                                # validated advisory kernel
noosphere exec import-plan docs/plan.md            # adopt a checkbox plan
noosphere exec clear --current
```

On resume the checkpoint is re-validated: evidence voids (superseded
snapshot, diverged Git); each target is classified honestly as
`target-unchanged`, `target-changed`, `target-missing`, or `unknown`.
`target-unchanged` only proves the target bytes match: assumptions and
dependencies still require validation, so no step is automatically actionable.
Age demotes past the 72-hour policy boundary and retention is 30 days; neither
value is accepted from checkpoint input. Checkpoints are per canonical agent in
`.noosphere/execution/<agent>.json|md`; overlapping live targets render a
visible `CONTENTION` warning. `exec clear` requires `--current`, `--agent`, or
`--all --confirm-all`. Local rebased salvage follows only the directly retained
validated parent, so it is deliberately conservative and limited.

Cross-machine exact synchronization requires every client to use the same
durable relayer index. Sharing Walrus credentials alone is not sufficient.
"walrus-backed/relayer-indexed" means Walrus replicates bytes while exact
lookup and heads still depend on that relayer index. Capabilities distinguish
local-only, shared-relayer, and walrus-backed/relayer-indexed deployments.

`.noosphere/continuity.json` is the canonical, content-addressed envelope;
`.noosphere/continuity.md` is a derived kernel of at most 1,800 bytes that a
fresh agent reads first. A handoff never overwrites conflicting work: a stale
update appends new distinct assertions, and every competing edit becomes an
explicit unresolved conflict. When mandatory conflicts or blockers would exceed
the kernel budget, the kernel refuses to summarize and points to
`noosphere state --json` instead.

## What Noosphere remembers

Noosphere supports two complementary kinds of memory.

### Automatic workspace checkpoints

After a short quiet period, the watcher records:

- changed file paths;
- current Git branch and commit;
- Git diff statistics;
- a workspace fingerprint;
- timestamp and project identity.

Raw source diffs are not uploaded by default.

### Explicit project memories

Agents and developers can store:

- architecture decisions;
- bug findings;
- implementation summaries;
- test results;
- failed approaches;
- research conclusions;
- session handoffs;
- unresolved blockers and next steps.

Automatic checkpoints preserve observable workspace state. Explicit memories
preserve intent and conclusions that cannot be inferred from files alone.

## Use Noosphere with an existing project

Noosphere does not require a new or empty repository. You can add it to a
project that has been running for months:

```sh
cd /path/to/existing-project
noosphere activate
```

On the first activation, every Git repository receives one project baseline.
There is no minimum age or commit count. A repository with one commit, five
commits, or hundreds of commits follows the same rule. Before the normal
watcher begins recording new changes, Noosphere prepares and stores this
starting point.

The baseline gives a new agent an initial map of the existing work:

- repository age and total commit count;
- current branch, HEAD, changed paths, and workspace fingerprint;
- tracked-file counts grouped by top-level directory;
- up to 50 recent commit dates, hashes, and subjects.

The local version is written to:

```text
.noosphere/baseline.md
```

The same summary is stored once in Walrus Memory as a `project-baseline`
record. Agents read it before the current master prompt, follow-ups, semantic
context, and journal. The watcher then treats that exact workspace state as
the starting point, so it records changes made after onboarding instead of
pretending the entire historical repository was created in one new session.

You can create or replace the baseline manually:

```sh
noosphere baseline
noosphere baseline --commits 100 --force
```

The selected history is capped at 200 commits. Configure automatic behavior in
`.noosphere/config.json`:

```json
{
  "onboarding": {
    "auto_baseline": true,
    "history_commits": 50
  }
}
```

### What the import cannot recover

Git can show code history, but it cannot reconstruct old AI chats, abandoned
ideas, verbal decisions, or requirements that were never committed. For a
long-running project, add the important missing knowledge explicitly:

```sh
noosphere remember --agent maintainer --type decision \
  "Production uses PostgreSQL. SQLite is supported only in local development."

cat existing-roadmap.md | noosphere master-prompt
```

From that point onward, automatic checkpoints and explicit memories preserve
new work normally across agents and machines.

## Restore on a fresh machine

Project memory survives losing the local checkout. After cloning the
repository to a new machine, a different workstation, or any directory where
`.noosphere/` is missing, run:

```sh
noosphere restore
```

The command reads `project_id` from `.noosphere/config.json` (or
`.noosphere.json` if you have not run `noosphere init` yet), then reconstructs
the durable shared files from Walrus:

- `.noosphere/baseline.md` — from the project-baseline record;
- `.noosphere/master-prompt.md` — from the master-prompt record;
- `.noosphere/followups.jsonl` — from every user-followup record;
- `.noosphere/context.md` — composed from the records above plus a fresh
  semantic recall.

Each file is restored only when the local copy is missing or empty. Existing
local content is never overwritten. The command is safe to run more than once.

### Requirements

- A `.noosphere/config.json` (or legacy `.noosphere.json`) with the same
  `project_id` used on the previous machine.
- Walrus Memory credentials provisioned on the new machine
  (`noosphere setup` and `noosphere credentials status` should both pass).
- Network access to the configured relayer.

### What does not come back

- `.noosphere/journal.md` — the local journal is only mirrored to Walrus when
  `privacy.share_journal` is `true`. If the previous machine kept it local,
  the journal does not survive the move.
- Hidden chain-of-thought or anything else that was never recorded by an
  agent.
- Automatic workspace checkpoints remain queryable through
  `noosphere recall` and `noosphere context`, but they are not written back
  into local files by `restore`; they are intentionally consulted through
  semantic search rather than stored as a static snapshot.

After `noosphere restore` completes, `noosphere activate` re-enables the
background watcher and the project resumes normal continuity.

## Why it works with any agent

Noosphere does not require every tool to support the same proprietary plugin.
The same project memory is available through multiple open interfaces:

| Interface | Best for |
| --- | --- |
| `.noosphere/context.md` | Any agent that can read project files |
| `.noosphere/journal.md` | Human-readable local notes and handoffs |
| `noosphere` CLI | Terminal agents and scripts |
| HTTP API | IDEs, web apps, agent frameworks, and custom clients |
| MCP | Agents that support the Model Context Protocol |

## Master prompts survive tool switches

When a substantial prompt defines multiple phases, Noosphere preserves the
exact prompt as pinned project intent in:

```text
.noosphere/master-prompt.md
```

Claude Code captures qualifying multi-phase prompts automatically through its
`UserPromptSubmit` hook. `noosphere ollama` does the same for every local
Ollama model. Noosphere also installs a Codex `UserPromptSubmit` hook and a
global Codex adapter, so prompts originating in Codex are captured and every
new Codex session reads pinned intent before project history. Codex asks you
to review a newly installed user hook once through `/hooks`.

This means a later instruction such as `continue with phase 2` is resolved
against the original phase definitions, not inferred from the phase 1
summary. Every later visible user prompt is appended exactly to
`.noosphere/followups.jsonl` and stored as a `user-followup` memory. Another
large master prompt is therefore preserved as a follow-up rather than erasing
the original. Replace the pinned original only when project intent genuinely
changes:

```sh
cat updated-plan.md | noosphere master-prompt --replace
```

For agents that do not expose prompt lifecycle events, pin the prompt once
through the command above or the HTTP API. Every agent can then read the same
exact file.

Agents determine what has already been done from three separate evidence
layers:

1. Current files, Git state, and tests are ground truth.
2. `.noosphere/journal.md` contains explicit findings and handoffs.
3. Metadata checkpoints and semantic Walrus recall show earlier activity.

Noosphere labels these as completion evidence rather than mixing them with
user intent. Agents are instructed to verify completion claims against the
working tree before continuing.

## Local models through Ollama

Every model installed in Ollama can join the same project memory:

```sh
cd /path/to/project
noosphere ollama qwen3-coder
```

Or run one prompt non-interactively:

```sh
noosphere ollama run minimax-m2 "Continue phase 2 from the existing handoff"
```

Noosphere refreshes shared memory before the first response, injects it as an
Ollama system message, keeps chat history for the session, and stores a concise
handoff when the session ends. The separate Ollama `thinking` field is never
added to shared memory. Local-model transcripts are marked unverified so later
agents know to check factual claims against current project files. Use
`--no-store` for a private session:

```sh
noosphere ollama llama3.2 --no-store
```

This works with any model served by Ollama's local API. File changes made
during a coding session are still captured by the independent project watcher.

Every new project receives only one `.noosphere/` folder. No Claude, Codex,
Gemini, Cursor, or MCP files are generated by default.

Tool-specific files are optional adapters. Add only the ones you use:

```sh
noosphere adapters --only claude
noosphere adapters --only claude,codex,mcp
```

They point compatible tools back to the same `.noosphere/` folder and do not
create separate memories for each vendor.

## Architecture

```text
AI tools
Codex / Claude Code / Cursor / IDE / CLI / HTTP / MCP
                         |
                         v
              Noosphere continuity layer
       files + CLI + HTTP API + project watcher
                         |
                         v
                 Configured memory backend
        local JSON file or Walrus Memory SDK
                         |
             +-----------+-----------+
             |                       |
             v                       v
       Local file memory      Walrus blob storage
       one-machine use        encrypted remote recall
```

### Walrus

Walrus stores the encrypted memory blobs. Walrus Memory also provides semantic
indexing and recall, allowing an agent to ask for the history relevant to the
current task instead of loading every old record.

### Sui

Sui is used by Walrus Memory for account ownership and delegate authorization.
No project memory text is stored directly on Sui, and Noosphere does not
require a custom smart contract.

### Noosphere

Noosphere provides the project-level continuity behavior:

- stable project namespaces;
- portable memory records;
- automatic Git-aware checkpoints;
- prompt-ready context files;
- universal interfaces;
- a durable upload queue;
- retry and restart recovery;
- local project lifecycle management.

## Quick start

Requirements:

- Node.js 22 or newer;
- npm;
- a Walrus Memory account and delegate key if you want shared remote memory.

### 1. Choose local file or Walrus Memory

```sh
cd noosphere-relayer
npm install
npm run demo
```

Open [http://127.0.0.1:3001](http://127.0.0.1:3001).

Local file mode uses a gitignored JSON file on this machine. It is useful for
people who do not want Walrus credentials, but it does not provide cross-machine
Walrus memory.

### 2. Connect Walrus Memory

```sh
cp noosphere-relayer/env.example noosphere-relayer/.env
```

Create or manage credentials in the
[Walrus Memory dashboard](https://memory.walrus.xyz/), then set:

```dotenv
MEMWAL_NETWORK=mainnet
MEMWAL_ACCOUNT_ID=0x...
MEMWAL_PRIVATE_KEY=...
NOOSPHERE_MEMORY_BACKEND=walrus-memory
DEMO_MODE=false
```

The `0x` prefix belongs on the account ID. The delegate private key is expected
as a 64-character hexadecimal Ed25519 key.

Noosphere validates that:

- the account exists on the selected Sui network;
- the account is active;
- the public key derived from the delegate private key is registered.

### 3. Install automatic continuity

From the repository root:

```sh
npm --prefix noosphere-mcp run install:user
~/.noosphere/bin/noosphere setup
```

The installer:

- copies a self-contained runtime to `~/.noosphere`;
- installs the `noosphere` command;
- configures per-user background services;
- adds activation hooks for zsh, bash, fish, and PowerShell;
- starts one project manager that supervises registered repositories.

The lifecycle installer supports macOS, Linux, and Windows.

### 4. Register a project

Entering a Git repository from an integrated shell activates it automatically.
You can also register it explicitly:

```sh
noosphere register --path /absolute/path/to/repository
```
Use the same command for projects opened only through a GUI IDE.

Noosphere does not scan the entire computer. Repositories are registered
explicitly or through the shell hook. Add `.noosphere-ignore` to opt out.

This command is the same for a new repository and an older one. Every project
automatically receives the bounded baseline described in
[Use Noosphere with an existing project](#use-noosphere-with-an-existing-project).

## Everyday workflow

### Start work

Read the current shared context:

```sh
noosphere context
```

Or recall a specific subject:

```sh
noosphere recall "What changed in authentication and what remains broken?"
```

### Store a finding or decision

```sh
noosphere remember \
  --agent codex \
  --type decision \
  "Use exponential backoff for retryable API failures."
```

Input can also come from stdin:

```sh
printf '%s\n' "Checkout rejects negative prices." |
  noosphere remember --agent claude-code --type finding
```

### Leave a local handoff note

```sh
noosphere journal \
  --agent cursor \
  "Verified the cache fix. Payment timeout handling remains unresolved."
```

The journal stays local unless project configuration explicitly enables
sharing it.

### End work

Store a concise handoff containing:

- what changed;
- what was verified;
- important decisions;
- unresolved problems;
- the best next step.

The next agent can retrieve it by meaning even if it uses a different tool or
model.

## CLI reference

```text
noosphere setup
noosphere credentials status
noosphere credentials migrate
noosphere credentials rotate
noosphere doctor
noosphere activate
noosphere deactivate
noosphere register --path /absolute/repository
noosphere projects
noosphere baseline
noosphere checkpoint
noosphere refresh
noosphere restore
noosphere status
noosphere context
noosphere recall "query"
noosphere remember --agent <name> --type <type> "content"
noosphere journal --agent <name> "note"
noosphere protocol
noosphere uninstall
```

## HTTP API

### Store memory

```http
POST /v1/actions
Content-Type: application/json
Idempotency-Key: <unique-action-id>

{
  "project_id": "payments-api",
  "agent_id": "codex",
  "action_type": "decision",
  "content": "Use idempotency keys for payment creation.",
  "session_id": "session-2026-06-12",
  "provider": "OpenAI",
  "model": "codex",
  "client": "CLI",
  "metadata": {
    "files": ["src/payments.js"]
  }
}
```

A successful response includes the configured backend's memory identifier,
managed memory ID, and project namespace. If Walrus is temporarily unavailable,
the API returns an accepted queued response and retries from durable local state.

### Recall relevant memory

```http
POST /v1/projects/payments-api/recall
Content-Type: application/json

{
  "query": "What decisions affect duplicate payments?",
  "limit": 10
}
```

### Get prompt-ready context

```http
GET /v1/projects/payments-api/context?q=duplicate%20payments&format=text
```

### Bootstrap any HTTP-capable agent

```http
GET /v1/projects/payments-api/bootstrap
```

The bootstrap response combines operating instructions with current semantic
project context.

### Discovery

- `GET /.well-known/noosphere.json`
- `GET /openapi.json`
- `GET /health`
- `GET /ready`

## MCP

Noosphere generates project MCP configuration for the official Walrus Memory
server:

```sh
npx -y @mysten-incubation/memwal-mcp@0.0.4 \
  --staging \
  --namespace noosphere-<project>
```

MCP is one access method, not the core protocol. Agents without MCP can use the
same memory through files, CLI, or HTTP.

## Project files

Default initialization creates:

```text
.noosphere/
├── baseline.md            Optional established-project onboarding snapshot
├── config.json             Project identity, privacy, and adapter settings
├── context.md              Refreshed context for file-reading agents
├── journal.md              Local public work notes and handoffs
├── protocol.json           Machine-readable continuity protocol
└── instructions.md         Human-readable universal instructions
```

The following files exist only after an explicit `noosphere adapters` command:

```text
CLAUDE.md                   Optional Claude adapter
AGENTS.md                   Optional Codex/generic adapter
GEMINI.md                   Optional Gemini adapter
.cursor/                    Optional Cursor adapter
.mcp.json                   Optional generic MCP adapter
```

The adapters are intentionally small. The durable memory remains in the
project's Walrus namespace.

## Privacy model

### Default checkpoint privacy

Automatic checkpoints are metadata-only. Raw source diffs are uploaded only
when `privacy.include_diff` is explicitly enabled in
`.noosphere/config.json`.

The established-project baseline is metadata-only too. It includes recent
commit subjects, changed paths, file-area counts, and repository timing
metadata, but no source contents or historical diffs. Disable
`onboarding.auto_baseline` before first activation when commit subjects are
sensitive.

### Managed relayer boundary

The managed Walrus Memory relayer receives plaintext to create embeddings and
apply Seal encryption before storing encrypted blobs on Walrus. This is not
zero-knowledge encryption with respect to the managed relayer.

### Temporary local plaintext

Pending uploads are stored in an owner-only durable queue until Walrus confirms
storage. The pending entry is removed after a successful upload.

### Credentials

`noosphere setup` stores credentials using the platform credential backend.
Linux systems without Secret Service fall back to an owner-only `0600` file.
Private keys are never printed by the setup or status commands.

### Hidden reasoning

Noosphere does not ask agents to reveal private chain-of-thought. Memories
should contain concise conclusions, evidence, and handoffs.

See [docs/PRIVACY.md](docs/PRIVACY.md) for the complete data path and
retention limitations, and
[noosphere-relayer/MEMORY_SECURITY.md](noosphere-relayer/MEMORY_SECURITY.md)
for the security boundary.

## Reliability

The relayer is designed for intermittent external-service failures:

- writes enter an atomic durable queue before upload;
- idempotency receipts survive restarts;
- temporary failures use exponential backoff;
- upstream cooldown hints are respected;
- uploads are serialized to avoid request storms;
- explicit user memories are prioritized before background checkpoints;
- queued writes resume after restart;
- readiness exposes pending jobs and the next upload slot.

The default service binds to `127.0.0.1`. Public or non-loopback deployments
require bearer authentication and explicit CORS origins.

## Important limitations

- Semantic recall returns relevant memories, not a guaranteed complete
  chronological audit log.
- Automatic checkpoints preserve observable Git state, not every unspoken
  decision made inside an agent session.
- Initial project onboarding cannot reconstruct old chats or undocumented
  decisions. It creates a bounded Git-derived starting point.
- Forgetting a project removes local registration but does not delete its
  existing Walrus memories.
- Memory retention follows Walrus Memory account and service behavior.
- The managed relayer is part of the plaintext trust boundary.
- Demo mode is local-only and should not be confused with Walrus-backed
  shared memory.

## Repository structure

```text
noosphere-relayer/
  index.js                 HTTP API and setup endpoints
  memory.js                Portable record serialization
  walrus-memory.js         Walrus Memory and Sui account adapter
  durable-store.js         Restart-safe queue and receipts
  security.js              Authentication, CORS, headers, rate limits
  local-projects.js        Local project controls
  credentials.js           Credential loading
  MEMORY_SECURITY.md       Encryption and authorization boundary

noosphere-mcp/
  continuity/              CLI, watcher, context refresh
  lifecycle/               Installer, services, registry, credentials
  hooks/                   Optional tool-specific hooks
  mcp-server/              MCP configuration and compatibility assets

docs/
  PRIVACY.md               Data handling and retention
  DEPLOYMENT.md            Public deployment and recovery
```

## Development and verification

Relayer:

```sh
cd noosphere-relayer
npm install
npm run check
npm test
```

Continuity and lifecycle:

```sh
cd noosphere-mcp
npm install
npm run check
npm test
```

Live Walrus verification is intentionally separate from routine tests:

```sh
cd noosphere-relayer
npm run test:live
```

## Deployment

The relayer binds to loopback by default. For a public deployment:

```dotenv
NODE_ENV=production
HOST=0.0.0.0
NOOSPHERE_API_TOKEN=<random-secret>
CORS_ORIGINS=https://your-noosphere.example
```

Generate a token with:

```sh
openssl rand -hex 32
```

Production and non-loopback startup fail closed when the token is missing.
Use TLS through Caddy, NGINX, or another trusted reverse proxy.

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for TLS, container, backup, and
recovery guidance.

## Project status

Noosphere is built for Sui Overflow 2026 using Walrus Memory and Sui account
authorization. The working system has been verified with live Walrus mainnet
store and recall, process restart, durable queue recovery, cross-agent CLI
handoffs, and automatic multi-project lifecycle management.
