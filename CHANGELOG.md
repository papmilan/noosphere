# Changelog

This repository publishes two npm packages that version independently:

- **`noosphere-continuity`** — the CLI, watcher, lifecycle installer, CSP task
  state, and ACP handoff state (source in [`noosphere-mcp/`](noosphere-mcp/));
- **`noosphere-relayer`** — the HTTP memory relay
  (source in [`noosphere-relayer/`](noosphere-relayer/)).

Dates are npm publish dates. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## noosphere-continuity

### Unreleased

- **SEC-05 Phase 5 replay-ledger release candidate.** Added owner-local,
  authenticated replay observations with content-based identity, monotonic
  counts, crash-recoverable journals, deterministic 4,096-record/90-day
  retention, typed restore suppression, and informational replay/freshness
  labels that never confer authority. Replay and random restore-candidate
  identities are fully separated; mutation paths enforce the global ranked
  lock hierarchy and production-reachable recovery. Inspection is limited to
  byte-for-byte read-only `replay status` and bounded `replay list`; package,
  MCP, HTTP, hook, lifecycle, adapter, and relayer surfaces expose no replay
  writer or replay-key reset/reinitialization operation. All 26 normative
  mutants are killed and every RPL invariant/test identifier is mapped.
  Multi-item typed refresh serializes replay observations to avoid self-lock
  evidence loss, and crash-lock behavior now explicitly refuses until owner
  intervention before production-path journal recovery. This entry does
  **not** close SEC-05: exact-head Linux/macOS/Windows CI and independent
  hostile review remain mandatory.
- **SEC-03 (Windows owner-only persistence) — closes SEC-03.** The centralized
  `@noosphere/secure-fs` boundary now enforces an exact three-SID Windows DACL
  (token user SID, `S-1-5-18`, `S-1-5-32-544`) via a fixed PowerShell/.NET helper:
  sensitive bytes are never written before a staged file's ACL is installed and
  read back, existing sensitive files are repaired before they are read, and
  directory junctions/reparse points are refused. Windows junction/reparse and
  owner-only ACL behavior, plus lifecycle-installed runtime packaging, run in
  mandatory Windows/Ubuntu/macOS CI with no relevant skips. This completes the
  SEC-03 filesystem boundary that the 2.3.1 patch began on POSIX. Merged in
  [PR #24](https://github.com/papmilan/noosphere/pull/24), merge commit
  `33c2737e9e7171482c908a8753f951b7cd694969`. Residual same-user TOCTOU,
  Developer-Mode symbolic links, and active local-administrator compromise are
  accepted by design (see
  [noosphere-relayer/SECURITY-FOLLOWUPS.md](noosphere-relayer/SECURITY-FOLLOWUPS.md)).

### 2.4.0 — 2026-07-18

- Added Continuation State Protocol v1: strict Git-tracked
  `.noosphere/state.json`, deterministic transitions and three-way merging,
  exact-file-identity optimistic concurrency, explicit terminal-state intent,
  and fail-closed migration of legacy watcher telemetry to the ignored
  `.noosphere/runtime-state.json`. Tracked CSP contains only durable task truth;
  Git, agent, revision, timestamp, and watcher observations remain runtime-only.
- Fixed legacy `.noosphere/state.json` containing JSON `null` to return the
  structured `state-file-ambiguous` migration error without changing the file;
  empty-object and malformed-JSON cases remain covered by fail-closed tests.
- `noosphere state` is now the CSP interface. ACP state moved to
  `noosphere acp state`; legacy ACP subcommands remain warning aliases for one
  release cycle.
- Generated agent adapters read durable CSP before observing Git separately
  and never parse journal prose into machine state when CSP exists.
- Stabilized the cross-platform test baseline with deterministic ACP offline
  retry ordering, portable durability/fsync behavior, permission assertions
  and ESM paths, native Windows lifecycle fixtures and argument handling, and
  bounded process-heavy ACP coverage.

### 2.3.1 — 2026-07-17

**Security patch.** Publishes the merged SEC-01/03/05 fixes.

- **SEC-01 (memory path):** every credentialed relayer request now passes
  through a single authority boundary. A repository-controlled `relayer_url`
  can no longer select a credential-bearing origin: unapproved or non-HTTPS
  non-loopback origins are refused before any network I/O, the API token is
  attached only to a loopback or owner-approved origin (owner-only
  `~/.noosphere/approved-relayers.json`), and origin-changing redirects are
  rejected.
- **SEC-01 (ACP exact-state):** the ACP exact-state sync client no longer owns
  the API token; it is routed through the same authority boundary, closing the
  automatic `activateProject` token-exfiltration path.
- **SEC-03 (POSIX increment):** centralized secure-filesystem boundary
  (no-follow, exclusive creation, realpath containment) applied to ACP
  project/execution state, locks, journals, temp files, and local memory;
  symlinked/reparse state directories and path components are rejected on POSIX.
  This was the POSIX portion; Windows junction/reparse containment and the
  owner-only SID ACL boundary that fully close SEC-03 landed later in PR #24 (see
  the Unreleased entry above). SEC-03 was not fully closed as of this 2.3.1 patch.
- **SEC-05:** recalled semantic memory is treated as untrusted quoted data —
  control characters, terminal escapes, and system-role/markup impersonation
  are sanitized, and recalled text is never injected into adapter instructions
  as authority.

### 2.3.0 — 2026-07-15

**ACP Execution Continuity.**

- Added the `acp.execution-state/1` object type: short-lived advisory
  checkpoints recording what an agent was about to do (current step, target
  file and symbol, remaining plan) bound to one Project State snapshot.
- New CLI commands: `noosphere exec checkpoint`, `exec show`,
  `exec import-plan`, and `exec clear` (which requires `--current`,
  `--agent`, or `--all --confirm-all`).
- The CLI measures repository head, branch, dirty state, workspace
  fingerprint, and per-step target hashes itself; asserted values are
  overwritten by measurement.
- Structural payload prohibition: fenced code, diff syntax, and multi-line
  prose are rejected at validation.
- Freshness model: only measured evidence voids a checkpoint; age demotes
  past a 72-hour policy boundary; implausible `created_at` values are
  rejected.
- Per-agent checkpoint isolation with explicit `CONTENTION` rendering when
  live targets overlap.
- Generated vendor adapters now load the master prompt, follow-ups, ACP
  kernel, and per-agent execution kernels before Git state and optional
  context.
- Docs: the ACP protocol reference moved to `docs/ACP.md`; package READMEs
  link to it instead of duplicating semantics.

### 2.2.0 — 2026-07-13

**ACP Project State and remote exact-state sync.**

- Added the `acp.project-state/1` envelope: objective, decisions, evidence,
  blockers, and next actions in a canonical content-addressed JSON file,
  with a derived kernel of at most 1,800 bytes for fresh agents.
- New CLI commands: `noosphere state` (`--json`, `validate`, `sync`,
  `push`, `pull`, `history`, `quarantine`) and `noosphere handoff`
  (`--stdin`, `--file`).
- Conflicting handoffs never overwrite: stale updates append distinct
  assertions and competing edits become explicit unresolved conflicts.
- Remote exact-state sync: read-only discovery, apply gated by a cached
  single-use `--confirm-remote` confirmation that expires within five
  minutes, quarantine for invalid or foreign bytes, and
  `NOOSPHERE_ACP_SYNC=false` to disable.
- Extracted the shared `@noosphere/acp-protocol` package (envelopes,
  schemas, validation, head sets), bundled into both published packages.
- Added a local-file memory backend so the full flow works without Walrus
  credentials.

### 2.1.6 — 2026-06-17

- Fixed Windows credential decryption under PowerShell 5.1 by loading the
  `System.Security` assembly before calling DPAPI `ProtectedData`, and
  using fully qualified type names.

### 2.1.5 — 2026-06-17

- Fixed a Windows DPAPI credential write that could leave a 0-byte
  credential file.

### 2.1.1 – 2.1.4 — 2026-06-16

- First published releases: cross-agent project memory CLI
  (`context`, `recall`, `remember`, `journal`, `master-prompt`), the
  background workspace watcher with metadata-only checkpoints, the
  per-user lifecycle installer for macOS/Linux/Windows, Ollama session
  support, and optional per-tool adapters.
- 2.1.2–2.1.4 were same-day packaging and setup fixes, ending with
  graceful degradation when Windows blocks `schtasks /Create`.

## noosphere-relayer

### 2.1.3 — 2026-07-18

- Made durability synchronization portable across supported platforms by
  keeping file handles write-capable, directory handles read-only, and
  suppressing only the known unsupported Windows directory-sync errors.

### 2.1.2 — 2026-07-17

**Security patch.**

- Relayer authority validation support: filesystem and credential stores are
  routed through the centralized secure-filesystem boundary (no-follow,
  exclusive creation, realpath containment), and symlinked/reparse state
  directories, credential files, and path components are rejected (SEC-03).
- Security hardening for the fallback credential and local-memory stores.

### 2.1.1 — 2026-07-15

- Added the package README (the npm page previously rendered none).
- Synchronized vendored `@noosphere/acp-protocol` package metadata with the
  source package; distribution parity is now derived from the protocol
  package manifest instead of a hardcoded file list.

### 2.1.0 — 2026-07-13

**ACP exact-state relay support.**

- Authenticated ACP exact-state API: durable server-owned index, snapshot
  backends (local and Walrus), apply-time confirmation, and owner-only
  quarantine with secured file permissions.
- Deterministic remote reconciliation bound to validated authority;
  expired ancestry is rejected.
- Exact upload jobs are retained across restarts; queue semantics
  hardened.
- Added the local-file memory backend
  (`NOOSPHERE_MEMORY_BACKEND=local-file`) and removed the static demo
  website.

### 2.0.4 — 2026-06-17

- Fixed Windows DPAPI credential handling in PowerShell 5.1 (missing
  `System.Security` assembly load; fully qualified type names).

### 2.0.1 – 2.0.3 — 2026-06-16

- First published releases: HTTP memory API (`/v1/actions`, recall,
  context, bootstrap), durable restart-safe upload queue with idempotency
  receipts, exponential backoff and cooldown handling, loopback-first
  security defaults with fail-closed token auth for non-loopback
  deployments, and Walrus Memory integration.
