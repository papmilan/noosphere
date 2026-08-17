# Changelog

This repository publishes two npm packages that version independently:

- **`noosphere-continuity`** — the CLI, watcher, lifecycle installer, CSP task
  state, and ACP handoff state (source in [`noosphere-mcp/`](noosphere-mcp/));
- **`noosphere-relayer`** — the HTTP memory relay
  (source in [`noosphere-relayer/`](noosphere-relayer/)).

Dates are npm publish dates. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## noosphere-continuity

### 2.5.0 — 2026-08-17

- **Inferred state lane.** CSP state now carries provenance, and a lane that
  guesses cannot escape: a local model may infer `current_task` from a commit
  into an untrusted lane that is never canonical, rendered on the documented
  read path and adoptable only by an explicit owner `state promote`. Inference
  runs from a detached post-commit hook so it cannot delay a commit, and no
  repository content leaves the machine past the loop that generates it. A
  commit is not asked for a `next_action` it does not contain, and an empty
  lane leaves no file behind.
- **Journal drafts from observed commits.** A post-commit hook records measured
  commit positions and drafts a journal entry from them, leaving the reasoning
  to be written in before an owner confirms. A pending draft is never
  overwritten, since it may hold prose that exists nowhere else. The hook is
  written through the safe filesystem primitive and pinned to its own
  repository rather than whatever repository happens to be active.
- **Installing from npm is supported for project continuity.** Every command
  that does not need the memory relayer now works from a registry install:
  previously the CLI resolved the relayer at module scope and died before
  reading argv, and the lifecycle commands died the same way for a second
  reason of their own. When the relayer genuinely is missing, the error names
  the command that installs it in the layout you are actually in rather than
  telling a registry user to clone a repository. `uninstall` and `doctor` no
  longer require the relayer at all. See the README for which commands need the
  relayer package and which need it running.
- **ACP and CSP locking.** Lock waits are bounded by wall clock, so a slow
  filesystem stops the wait instead of silently changing the timeout with the
  retry count. A failed lock write no longer leaks its descriptor or the lock
  itself, a refused lock unwinds the locks beneath it, a stale lock reclaim
  takes the lock that was judged rather than whatever is present at reclaim
  time, and a Windows `EPERM` on the lock file is treated as contention rather
  than a fault. CSP state persists without hard links and recovers where they
  are unavailable.
- **Replay.** A peer that loses the first-use race adopts the key instead of
  failing, and a peer that replaces the key or misses the catalog is no longer
  refused outright.
- **Watcher.** A watcher whose repository goes away stops and says so instead of
  retrying forever; a subdirectory is no longer mistaken for a vanished disk.
  The watcher no longer takes `.git/index.lock`, backs off when it fails at
  startup, and keeps local telemetry out of Git in every project rather than
  only the one it was configured in.
- **`doctor`.** Health is decided from the relayer's `/ready` response rather
  than file presence alone, uploads that are not landing now fail the check,
  and a manager running older code than is installed is reported.
- **Lifecycle and services.** Service logs are capped, Windows services are
  given a working directory, a reinstall no longer copies a runtime directory
  onto itself, and the CLI wrapper name is resolved from one place. macOS
  keychain credential storage works.
- **Context and diagnostics.** The journal section of `context.md` is bounded,
  journal prose is normalized before it reaches `context.md` through the
  registered normalizer rather than a weaker private copy, and a failing
  relayer says which relayer failed and why instead of `fetch failed`.
- **SEC-05 Phase 5 replay ledger — closes SEC-05.** Added owner-local,
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
  intervention before production-path journal recovery. Windows ACL
  operations are served by a persistent length-framed helper instead of one
  process per inspection, removing the dominant Windows CI cost. Both closure
  gates passed at final head `d6dc0b6`: tri-platform exact-head CI
  ([run 30526063300](https://github.com/papmilan/noosphere/actions/runs/30526063300))
  and an independent exact-head hostile review with no Critical, Important, or
  Minor finding. Merged in
  [PR #35](https://github.com/papmilan/noosphere/pull/35), merge commit
  `c54189b`. Evidence:
  [docs/security/SEC-05-PHASE-5-VERIFICATION.md](docs/security/SEC-05-PHASE-5-VERIFICATION.md).
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
  the 2.5.0 entry above). SEC-03 was not fully closed as of this 2.3.1 patch.
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

### 2.1.4 — 2026-08-17

**Dependency patch.** No source changes.

- Updated `body-parser` (2.2.2 → 2.3.0) for GHSA-v422-hmwv-36x6, where an
  invalid `limit` value silently disabled body size enforcement, and `valibot`
  (1.4.1 → 1.4.2) for GHSA-5qjj-4xww-7phc. Both arrive transitively, through
  `express` and `@mysten/sui` respectively, and both sat below the
  `--audit-level=high` gate CI enforces, so neither was failing a build.
- `noosphere-continuity` pins this package as an exact optional peer
  dependency, so its `peerDependencies` entry moves to 2.1.4 in step.

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
