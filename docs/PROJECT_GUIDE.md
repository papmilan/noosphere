# Noosphere project guide

**Documentation version:** 1.0
**Verified against the repository:** 2026-08-27
**Primary readers:** users, contributors, operators, and security reviewers

This guide is the map of the entire Noosphere monorepo. It explains how the
continuity product, the local relayer, the Agent Cognitive-state Protocol
(ACP), and Project Memory MCP packages fit together. Component guides remain
the authority for exact protocol, security, and deployment details; this page
connects those guides and records the boundaries between them.

## Choose the right Noosphere surface

Noosphere contains two related memory surfaces. They share the goal of durable
agent continuity, but they are separate applications.

| Surface | Use it for | Primary interface | Storage |
| --- | --- | --- | --- |
| Repository continuity | Git-project task state, handoffs, journal, automatic workspace checkpoints, semantic recall | `noosphere` CLI, project files, local relayer HTTP | `.noosphere/`, owner-local state, optional Walrus Memory |
| Project Memory MCP | Structured projects, sessions, and checkpoint history for MCP clients | Local STDIO MCP or remote Streamable HTTP MCP | owner-local JSON file or PostgreSQL |

The `noosphere-relayer` HTTP API and the Remote Project Memory MCP server are
not interchangeable. The relayer serves repository memories and ACP exact-state
snapshots. The MCP server exposes the versioned Project Memory tool contract.

## Package inventory

The repository has nine package directories plus one vendored protocol mirror.
Only `noosphere-continuity` and `noosphere-relayer` currently have the public
release history recorded in the root changelog. Treat `0.0.0` packages as
monorepo components unless a release explicitly says otherwise.

| Directory | Package / version | Entry point | Responsibility |
| --- | --- | --- | --- |
| `noosphere-mcp/` | `noosphere-continuity` 2.5.1 | binary `noosphere` → `continuity/index.js` | CLI, watcher, project lifecycle, CSP, ACP client/state, adapters, hooks, Ollama wrapper |
| `noosphere-relayer/` | `noosphere-relayer` 2.1.4 | `index.js` | single-user HTTP memory relay, durable queue, local-file/Walrus backends, ACP exact-state index |
| `noosphere-acp-protocol/` | `@noosphere/acp-protocol` 0.1.0 | `index.js` | canonical ACP wire format, schemas, project/execution validation, head-set hashing |
| `noosphere-secure-fs/` | `@noosphere/secure-fs` 1.0.0 | `index.js` | centralized contained-path, bounded-read, atomic-write, lock, and Windows owner-ACL boundary |
| `noosphere-remote-mcp/` | `@noosphere/remote-mcp-contracts` 0.0.0 | `index.js` | Project Memory schemas, errors, in-memory repository contract, service logic, cursors |
| `noosphere-remote-mcp-postgres/` | `@noosphere/remote-mcp-postgres` 0.0.0 | `src/repository.js`, `src/oidc.js`, `migrate.js` | PostgreSQL repository, OIDC verifier, migrations, retention jobs |
| `noosphere-remote-mcp-server/` | `@noosphere/remote-mcp-server` 0.0.0 | binary `noosphere-remote-mcp-server` → `src/main.js` | Streamable HTTP MCP transport, OAuth resource metadata, auth/CORS/session gate |
| `noosphere-local-mcp/` | `@noosphere/local-mcp` 0.0.0 | binary `noosphere-local-mcp` | single-user STDIO MCP transport with durable owner-local storage |
| `noosphere-remote-mcp-acceptance/` | `@noosphere/remote-mcp-acceptance` 0.0.0 | test suite only | SDK-driven cross-client and transport acceptance scenarios |
| `noosphere-relayer/vendor/acp-protocol/` | vendored mirror | `index.js` | ACP source copied into the relayer Docker build context; parity is tested |

There is intentionally no root `package.json`. Run npm commands with
`--prefix <package-directory>` or from inside the relevant package.

## Architecture

### Repository continuity flow

```text
shell / IDE / agent
        │
        ├─ reads trust-gated `.noosphere/` context
        ├─ runs the `noosphere` CLI
        └─ activates a Git project
                 │
        per-user project manager
                 │ one watcher per registered project
                 ▼
       measured Git checkpoint + local CSP/ACP state
                 │
                 ▼
        noosphere-relayer on 127.0.0.1:3001
                 │
          ┌──────┴────────┐
          ▼               ▼
 owner-local JSON     Walrus Memory
                      (managed plaintext processing,
                       encrypted blob storage)
```

The watcher records observable repository metadata after the working tree
settles. It does not infer task completion. Explicit decisions, findings, test
results, and handoffs must be written through `remember`, `journal`, CSP, or
ACP. The Claude `SessionEnd` hook appends a bounded local journal handoff before
attempting an optional upload; the local append does not depend on network
success. It reads only the newest bounded window of large Claude transcripts,
so a long session still contributes its final assistant summary. Invalid
project configuration suppresses remote upload but not the local record; a
failed local append returns a visible hook error instead of claiming success.
Hook installation is idempotent and removes duplicate current or legacy
Noosphere entries without deleting unrelated Claude hooks. Journal appends are
serialized with an owner-only process lock. If a hook is killed after taking
that lock, the next append verifies that the owner process is dead and safely
recovers the orphan instead of silently abandoning future handoffs. The
reclaimer uses a process-owned directory guard and accepts only the exact
AppleDouble metadata companion macOS creates for that marker on external
volumes; unrelated entries remain a fail-closed condition.

### Project Memory MCP flow

```text
MCP client
   ├─ Local STDIO ── fixed local owner ── owner-only JSON snapshot
   └─ Remote HTTP ── OIDC verifier ── owner scope ── PostgreSQL
                              │
                    shared ProjectMemoryService
                              │
                   16 closed-schema MCP tools
```

Both transports use `buildProjectMemoryMcpServer` and the same service and tool
schemas. The local executable persists at
`~/.noosphere/local-mcp/project-memory.json`. The library factory still permits
an injected in-memory repository for tests and embedding.

The remote server holds open MCP transport sessions in process memory. A
restart requires clients to reconnect. Multiple replicas require
`Mcp-Session-Id` affinity. Project, session, checkpoint, and idempotency data
remain in PostgreSQL.

## Install and run repository continuity

Requirements: Node.js 22 or newer, npm, and Git.

```sh
git clone https://github.com/papmilan/noosphere.git
cd noosphere
npm --prefix noosphere-mcp run install:user
~/.noosphere/bin/noosphere setup
```

Use `noosphere setup --local` when you want local-file memory and no Walrus
credentials. Run `noosphere doctor` after installation, upgrades, or credential
rotation.

The npm registry installation is supported for the published packages:

```sh
npm install noosphere-continuity noosphere-relayer
```

Install both when lifecycle, credential, and memory commands are needed. The
continuity-only commands can run without the relayer package; the root
[README](../README.md#installing-from-npm) records the exact split.

### Platform lifecycle

| Platform | Per-user services | Shell activation | Restart and logs |
| --- | --- | --- | --- |
| macOS | LaunchAgents for relayer and manager | zsh/bash/fish; existing PowerShell Core profiles | `KeepAlive`; logs under `~/.noosphere/logs/` |
| Linux | `systemd --user` units | zsh/bash/fish; existing PowerShell Core profiles | `Restart=always`; logs under `~/.noosphere/logs/` |
| Windows | Task Scheduler `Noosphere\Relayer` and `Noosphere\Manager` | PowerShell 7 and Windows PowerShell all-host profiles, created for a fresh user | hidden WScript launchers, one-minute restart-on-failure, logs under `~/.noosphere/logs/` |

PowerShell activation runs asynchronously and hidden, so changing directories
must not block on relayer timeouts or open a console window. Windows owner-only
ACL enforcement uses a hidden PowerShell/.NET helper because Node does not
provide the required exact-SID DACL API. A running Noosphere Node process may
therefore have a hidden helper child; visible PowerShell windows are not normal.
The profile hook is process-global and idempotent, so dot-sourcing a profile
again does not stack another directory-change handler or multiply launches.
Scheduled-task wrappers verify the working directory before starting Node and
preserve the service exit status in their logs.

If a service manager is unavailable, run `noosphere run-relayer` and
`noosphere run-manager` in foreground terminals. `doctor` distinguishes task or
unit registration from the running manager marker and reports a dead/stale
manager.

## Continuity CLI map

Run `noosphere` with no command for the live command help. The command groups
are:

| Area | Commands |
| --- | --- |
| Installation | `install`, `uninstall`, `doctor`, `setup`, `credentials`, `run-relayer`, `run-manager` |
| Project lifecycle | `init`, `activate`, `deactivate`, `register`, `projects`, `pause`, `resume`, `forget`, `watch` |
| Context and memory | `baseline`, `checkpoint`, `refresh`, `status`, `context`, `recall`, `remember`, `journal`, `master-prompt`, `protocol` |
| Observation and local inference | `observe`, `infer`, `hooks`, `ollama` |
| Agent adapters | `adapters` |
| Owner security | `approve-relayer`, `trust`, `restore`, `replay` |
| CSP | `state` and its `show`, `set`, `next`, `reopen`, `restore`, `infer`, `inferred`, and `promote` operations |
| ACP | `acp state`, `handoff`, and `exec` |

`capture-prompt`, `share-master-prompt`, and `share-followup-prompt` are support
surfaces used by installed hooks. They are not normal interactive workflow
commands.

Exact command behavior and the owner-confirmation ceremonies are documented in
the [continuity package README](../noosphere-mcp/README.md). ACP envelope and
execution semantics are documented in [ACP.md](ACP.md). CSP's normative state
machine is documented in [CSP.md](../CSP.md).

## Project configuration

`noosphere init` or `activate` creates `.noosphere/config.json`. These are its
current fields and defaults:

| Field | Default | Meaning |
| --- | --- | --- |
| `project_id` | sanitized repository directory name | stable project namespace |
| `relayer_url` | `http://127.0.0.1:3001` | repository-memory and ACP exact-state relayer |
| `checkpoint_debounce_ms` | `8000` | quiet period before an automatic checkpoint |
| `context_refresh_ms` | `300000` | periodic context refresh interval |
| `privacy.checkpoint_content` | `metadata-only` | declared checkpoint privacy mode |
| `privacy.include_diff` | `false` | include raw Git diff text in uploaded checkpoints |
| `privacy.share_journal` | `true` | include/upload public journal content |
| `privacy.capture_master_prompt` | `true` | permit automatic qualifying prompt capture |
| `onboarding.auto_baseline` | `true` | create the first bounded Git-history baseline |
| `onboarding.history_commits` | `50` (maximum 200) | recent commit subjects in the baseline |
| `adapters` | `[]` | selected `claude`, `codex`, `gemini`, `cursor`, or `mcp` adapters |

The project value of `relayer_url` wins when present. `NOOSPHERE_RELAYER_URL`
is a fallback for configurations without that field. A credential-bearing
request may reach only a loopback origin or an exact HTTPS origin approved with
`noosphere approve-relayer`.

## Project files and owner-local files

Important Git-project files:

| Path | Role | Authority |
| --- | --- | --- |
| `.noosphere/state.json` | canonical CSP task state | machine state, schema validated |
| `.noosphere/runtime-state.json` | branch/HEAD/watcher observations | ignored runtime evidence |
| `.noosphere/continuity.json` | canonical ACP Project State envelope | validated advisory state |
| `.noosphere/continuity.md` | bounded ACP rendering | derived, advisory |
| `.noosphere/execution/*.json` | per-agent ACP execution checkpoints | short-lived, advisory |
| `.noosphere/journal.md` | public findings and handoffs | prose evidence, not machine state |
| `.noosphere/context.md` | cached rendered context | derived; do not treat raw bytes as authority |
| `.noosphere/master-prompt.md` | exact pinned intent | untrusted until owner-approved exact bytes |
| `.noosphere/followups.jsonl` | later visible user prompts | quoted data |
| `.noosphere/config.json` | project settings | repository-controlled configuration |

Important owner-local state lives under `~/.noosphere/`: installed binaries and
application copies, service logs, project registry, approved relayer origins,
trust/replay/restore state, credentials fallback, and Local STDIO Project Memory.
These files are not portable project truth. Back them up according to the
[deployment guide](DEPLOYMENT.md#backup-and-recovery).

## Project Memory MCP tools

Both Local STDIO and Remote HTTP expose these 16 tools:

| Tool | Purpose |
| --- | --- |
| `create_project` | create an active project |
| `list_projects` | page through visible projects; archived projects are opt-in |
| `get_project` | retrieve one exact project |
| `find_projects` | resolve exact matches or return explicit ambiguity |
| `update_project` | change mutable project metadata |
| `archive_project` | move a project to archived lifecycle state |
| `create_session` | begin an attributed client/model session |
| `get_session` | retrieve one session |
| `list_project_sessions` | page through a project's sessions |
| `transition_session` | move a session to an allowed lifecycle status |
| `save_checkpoint` | atomically append an idempotent linear checkpoint |
| `get_latest_checkpoint` | retrieve the current head, if any |
| `get_checkpoint` | retrieve one exact checkpoint |
| `list_checkpoints` | page through checkpoint history |
| `resume_project` | return the durable continuation package and freshness warnings |
| `get_project_summary` | return a bounded project overview |

Inputs are closed objects: unknown fields are rejected. Authentication identity
is never accepted as tool input. Stored checkpoint content is returned with
`content_trust: "untrusted-persisted-data"`. See the exact
[tool contract](project-memory/MCP_TOOL_CONTRACT.md) and JSON schemas under
`noosphere-remote-mcp/schemas/`.

### Local STDIO

From a checkout, configure an MCP host to execute:

```json
{
  "mcpServers": {
    "noosphere-local": {
      "command": "node",
      "args": ["/absolute/path/to/noosphere-local-mcp/bin/noosphere-local-mcp.js"]
    }
  }
}
```

The process has one fixed local owner, no network listener, and no OIDC. Its
owner-only JSON file survives ordinary host restarts. Independent MCP hosts can
share the default store: every mutation takes an owner-only cross-process lock,
reloads the newest durable snapshot, and atomically commits its replacement.
Readers refresh from disk, so one host observes another host's committed work.

### Remote HTTP

The production server exposes:

- `POST`, `GET`, and `DELETE /mcp` as required by Streamable HTTP MCP;
- `GET /healthz` for process liveness;
- `GET /readyz` for repository readiness;
- `GET /.well-known/oauth-protected-resource` for RFC 9728 discovery.

Use the [Remote MCP documentation index](remote-mcp/README.md) for the exact
environment, Docker Compose, systemd, reverse-proxy, migration, backup, upgrade,
and rollback procedures.

## Relayer HTTP and configuration

The local relayer defaults to `127.0.0.1:3001`. Its public discovery document is
`GET /.well-known/noosphere.json`; its generated OpenAPI document is
`GET /openapi.json`. Liveness and readiness are `GET /health` and `GET /ready`.

Core API groups:

- memory: `/v1/actions`, `/v1/projects/:project_id/recall`, `context`, and
  `bootstrap`;
- ACP exact state: `/v1/acp/capabilities` and project `snapshots`, `heads`, and
  `history` routes;
- loopback-only local control: `/v1/local/projects` and
  `/v1/local/credentials` routes.

Copy `noosphere-relayer/env.example` for the complete current environment
surface. The important groups are listener/auth/CORS/rate limit, durable queue
and snapshot paths, local-file or Walrus backend selection, retry intervals,
and Walrus account/network endpoints. Public or non-loopback startup fails
closed without `NOOSPHERE_API_TOKEN`.

The relayer is a single-instance design: its queue, receipts, rate limiter, and
exact-state index are process/local-volume state. Do not deploy it active-active.

## Security and trust model

The security boundary is based on explicit provenance, exact owner approval,
and fail-closed persistence:

1. Repository-controlled prompt, instruction, baseline, follow-up, recalled
   memory, and checkpoint content starts as untrusted data.
2. `noosphere context --local-only` renders trust labels. Agents must not read
   raw authority-capable files as instructions.
3. Only an interactive owner approval can bind the exact current bytes of a
   master prompt, instructions file, or baseline.
4. ACP content is canonicalized, content-addressed, schema validated, and
   advisory. Execution state cannot carry code, patches, or hidden reasoning.
5. Project Memory derives remote ownership from verified OIDC issuer and
   subject. Every repository operation is owner-scoped.
6. Persisted Project Memory checkpoint text is explicitly labeled untrusted.
7. `@noosphere/secure-fs` rejects redirected sensitive paths, bounds reads,
   performs atomic replacement, and enforces owner-only storage, including
   exact Windows SID ACLs.
8. Credentials and bearer tokens never belong in project files, logs, MCP tool
   arguments, or tool results.

Read [SECURITY.md](../SECURITY.md) for reporting, supported releases, authority
ceremonies, accepted local-machine residuals, and the full hardening model.
Read [PRIVACY.md](PRIVACY.md) for plaintext boundaries and retention.

## Development and verification

Install dependencies in every package you intend to exercise. Several suites
load sibling package source, so their dependencies must also be installed.
The complete local command map is:

```sh
npm --prefix noosphere-acp-protocol test
npm --prefix noosphere-secure-fs run check

npm --prefix noosphere-relayer run check
npm --prefix noosphere-relayer run test:security
npm --prefix noosphere-mcp run check
npm --prefix noosphere-mcp run test:security

npm --prefix noosphere-remote-mcp test
npm --prefix noosphere-remote-mcp-server test
npm --prefix noosphere-local-mcp test
npm --prefix noosphere-remote-mcp-acceptance test

npm --prefix noosphere-remote-mcp-postgres run test:nodb
npm --prefix noosphere-remote-mcp-postgres run db:up
npm --prefix noosphere-remote-mcp-postgres run migrate
npm --prefix noosphere-remote-mcp-postgres run test:db
npm --prefix noosphere-remote-mcp-postgres run db:down

node scripts/docker-build.mjs remote-mcp
node scripts/docker-build.mjs relayer
```

`db:down` removes the disposable Docker Compose database volume. Do not use it
for a database containing data you need.

The Docker helper stages a sanitized temporary context before invoking
BuildKit. This is the portable build path for macOS external volumes, where
AppleDouble `._*` metadata can otherwise make Docker fail while reading xattrs
before ignore rules take effect. It excludes secrets, installed dependencies,
tests, metadata sidecars, symlinks, and non-regular filesystem objects, then
removes the context after the build.

Live Walrus verification is deliberately separate and requires real delegate
credentials:

```sh
npm --prefix noosphere-relayer run test:live
```

Before release, also run package audits, package dry-runs for changed published
packages, `git diff --check`, and the Windows filesystem verification kit when
the secure filesystem or lifecycle changes. The exact Windows command and
tested platform matrix are in
[windows-filesystem-verification.md](security/windows-filesystem-verification.md).

CI runs continuity and relayer checks/security suites on Linux, macOS, and
Windows; dedicated SEC-05 shards on all three; PostgreSQL DB tests on Linux;
remote server, acceptance, and Local STDIO suites on Linux; image/deployment
checks; dependency/secret/container scans; and an opt-in live Walrus workflow.

## Operational limitations

- A green test proves only the asserted behavior. Continuity claims still need
  verification against Git, files, and relevant external systems.
- Semantic recall is ranked retrieval, not a complete chronological audit log.
- Automatic checkpoints cannot recover unrecorded conversation state or
  undocumented intent.
- The managed Walrus Memory relayer processes plaintext before encrypted blob
  storage. It is part of the trust boundary.
- The local relayer is not active-active. Exact-state durability depends on its
  durable state and snapshot volumes, not Walrus credentials alone.
- Remote MCP transport sessions are process-local and need affinity across
  replicas. Pagination cursors remain valid across restarts and replicas only
  while every instance uses the same `NOOSPHERE_CURSOR_SECRET`.
- Local STDIO mutations are serialized across processes with a bounded
  owner-only lock. A later writer safely recovers a lock whose recorded owner
  process is dead; live, malformed, symlinked, or otherwise unverifiable lock
  state fails closed after a bounded wait.
- Windows exact-SID ACL handling depends on PowerShell/.NET. Its helper must be
  hidden; absence or an unclassified ACL failure fails sensitive persistence
  closed.
- Noosphere records conclusions and evidence, never hidden chain-of-thought.

## Documentation index

| Document | Reader / purpose |
| --- | --- |
| [README.md](../README.md) | product overview and five-minute start |
| [noosphere-mcp/README.md](../noosphere-mcp/README.md) | full continuity CLI and owner-authority operations |
| [noosphere-relayer/README.md](../noosphere-relayer/README.md) | local relayer quick start and HTTP surface |
| [CSP.md](../CSP.md) | normative Continuation State Protocol |
| [ACP.md](ACP.md) | ACP Project State, execution, and sync protocol |
| [PRIVACY.md](PRIVACY.md) | data path, plaintext boundaries, retention |
| [DEPLOYMENT.md](DEPLOYMENT.md) | local relayer deployment and recovery |
| [remote-mcp/README.md](remote-mcp/README.md) | Remote Project Memory operator documentation |
| [project-memory/](project-memory/) | Project Memory contract, lifecycle, and threat model |
| [SECURITY.md](../SECURITY.md) | security policy, trust model, residuals, reporting |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | development setup, gates, contribution policy |
| [CHANGELOG.md](../CHANGELOG.md) | published continuity and relayer history |
| [docs/adr/](adr/) | accepted architecture decisions |
| [docs/design/](design/) | implementation designs and plans |
