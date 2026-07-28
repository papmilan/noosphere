# SEC-05 Phase 4C — Conformance Verification Record

Status: **not released.** Findings 1, 2, 3, 4, 6, and 8 through 14 are closed. An
independent hostile review at head `3f23c7b` returned REQUEST CHANGES with seven
POSIX-independent findings across two passes; all seven are fixed here, each with
a dedicated mutation-checked regression. Release is blocked on: a re-review at
the new head, a green Windows job (Finding 7 — latency, deferred by the owner),
and an approving review from someone other than the implementer.

This document is the traceable requirement-to-test matrix for SEC-05 Phase 4C,
plus the exact evidence produced while verifying it. Nothing here is inferred: a
platform cell says `pass` only where that platform's runner actually executed the
case.

## 1. Verified head

| Field | Value |
|---|---|
| Branch | `codex/sec-05-phase-4c1` |
| Head | `f8c8689` — `fix(restore): keep the liveness verdict off the injectable clock` |
| Commit range | `d2992c3..f8c8689` — 18 Phase 4C commits on top of `origin/main` |
| Merge base | `d2992c3f1ac3fd10bbd0abb9e1192bdc7193a016` |
| Pull request | [#34](https://github.com/papmilan/noosphere/pull/34) — **draft, do not merge** |
| CI run | [30377401209](https://github.com/papmilan/noosphere/actions/runs/30377401209) — head `1dd5466` |
| Node | v24.12.0 local, 22.23.1 on CI |
| npm | 11.6.2 |
| Local verification host | macOS 26.5.2, arm64 |
| Local Linux verification | `node:22` container, x86-64 under emulation |

### Remediation commits

| Commit | Subject |
|---|---|
| `45383ad` | test(security): lock down phase 4c writer surfaces |
| `d0121db` | docs(security): record phase 4c verification evidence |
| `3d60be8` | fix(restore): recover crashed transactions in the production path |
| `f35f0f8` | docs(security): document the owner authority commands |
| `80dcf16` | test(security): drive migration through the PTY prompt, not ahead of it |
| `fbd940b` | docs(security): record the phase 4c remediation evidence |
| `f8c8689` | fix(restore): keep the liveness verdict off the injectable clock |

## 2. Conformance matrix

Implementation cells name an exact function and file. Test-evidence cells name an
exact test case. The gate in `noosphere-mcp/tests/phase4c-conformance.test.js`
asserts every cell mechanically: if an implementation symbol or an evidence case
name disappears, the gate fails.

Platform columns record whether that platform's runner executed the shard
containing the evidence. `L`/`M`/`W` are the Linux, macOS and Windows jobs of CI
run 30377401209 at head `1dd5466`.

| Spec section | Invariant | Implementation | Test evidence | L | M | W |
|---|---|---|---|---|---|---|
| Authority cutover | Loading the dispatcher retires format 1 irreversibly; legacy state is inventory only | `isSlotAuthoritative` — `continuity/trust-store.js` | `makes a valid format-1 approval inert before migration inventory`; `keeps format 1 inert after Phase 4C manifest deletion`; `keeps format 1 inert after binding deletion or corruption` — `tests/trust-phase4c-cutover.test.js` | pass | pass | **fail — Finding 4** |
| Generations | Generations are append-only; a rolled-back or missing manifest is invalid, never permissive | `buildApprovedGeneration` — `continuity/internal/trust-generation.js` | `appends N+1 tombstone, is idempotent, and reapproves only at N+2`; `classifies missing or rolled-back manifests with generation artifacts as invalid` — `tests/trust-revocation.test.js`; `chains immutable events and rejects substitution or truncation` — `tests/trust-audit.test.js` | pass | pass | **fail — Finding 4** |
| Revocation | Tombstones are authenticated, canonically shaped, and domain-bound | `revokeSlot` — `continuity/internal/revocation-service.js` | `builds the one exact canonical tombstone shape`; `rejects forbidden, null, inherited, unknown, and omitted tombstone fields`; `quarantines a MAC-invalid tombstone and its authenticated incomplete journal` — `tests/trust-revocation.test.js`; `rejects every ordered cross-domain substitution` — `tests/trust-domain-separation.test.js` | pass | pass | **fail — Finding 4** |
| Migration | Every eligible slot requires a fresh owner approval; no legacy state is promoted | `migrateTrustInventory` — `continuity/internal/migration-service.js` | `requires a distinct normal approval for every eligible slot`; `never restarts invalid current Phase 4C history from legacy inventory`; `never prompts over a current authenticated tombstone`; `checks both TTY streams before inventory or mutation` — `tests/trust-migration.test.js` | pass | pass | **fail — Finding 4** |
| Field splicing | No single field can be exchanged for another record's value while the MAC is preserved | `verifyRecord` — `continuity/internal/authenticated-records.js` | `refuses every spliced field of a real apply journal`; `refuses every spliced field of a real approved generation, manifest, and audit event`; `refuses a spliced record at the production reader, not only at the MAC` — `tests/trust-record-splicing.test.js` | pass | pass | not run |
| Concurrent transitions | Exactly one transition commits from an observed generation; losers get typed refusals; no generation reuse, tombstone bypass, stale-destination apply, or lost audit event | `acquireLock` — `continuity/internal/trust-format-v2.js` | `lets exactly one transition commit from one observed generation`; `refuses a second commit against an already-spent observed generation`; `never reuses a generation across a burst of racing approvals`; `never lets a racing approval bypass a tombstone`; `races per-slot migration approval against a direct approval`; `never applies two restores to the same destination concurrently`; `never lets a restore apply land against stale destination bytes`; `races a restore apply against an authority transition on the same slot` — `tests/trust-concurrency.test.js` | pass | pass | not run |
| Migration ceremony ordering | A confirmation typed before its prompt was displayed is discarded, not accepted | `readExactConfirmation` — `continuity/internal/exact-confirmation.js` | `requires distinct confirmations through a genuine PTY for two eligible slots`; `discards input typed before its prompt was displayed` — `tests/trust-migration.test.js` | pass | partial — PTY case passes; type-ahead case is `not applicable: needs script(1) with -c` | **not applicable: no PTY allocator — Finding 5** |
| Restore staging | Staging authenticates a candidate and changes no project file and no authority state | `stageRestoreCandidate` — `continuity/internal/restore/candidate-store.js` | `stages one authenticated candidate without changing project files`; `fails closed on payload tampering and unsafe candidate-shaped entries`; `checks both TTY streams before recall or mutation` — `tests/restore-store.test.js`; `accepts only the four normative restore productions` — `tests/restore-cli.test.js` | pass | pass | **fail — Finding 4** |
| Restore apply | The final barrier completes before the first temporary write; destination races fail closed; authority is recomputed, never asserted | `applyRestoreCandidate` — `continuity/internal/restore/apply-service.js` | `runs the complete final barrier before the first temporary write`; `detects a destination race after the barrier before creating the temporary file`; `applies into a revoked slot without changing its tombstone or authority`; `recomputes authority from the live bytes and current manifest` — `tests/restore-apply.test.js` | pass | pass | **fail — Finding 4** |
| Receipts | A receipt is immutable, authenticated, and audit-only — it confers no authority | `commitRestoreReceipt` — `continuity/internal/restore/receipt-store.js` | `commits an immutable authenticated audit-only receipt` — `tests/restore-receipt.test.js` | pass | pass | **fail — Finding 4** |
| Consumed markers | A spent confirmation cannot be replayed, rebound, or rolled back | `commitConsumedMarker` — `continuity/internal/restore/receipt-store.js` | `commits an independent authenticated consumed marker and rejects tampering` — `tests/restore-receipt.test.js`; `spends the issued context after one wrong phrase and refuses replay`; `cannot bind one spent confirmation transaction to another candidate`; `rejects authenticated current-state rollback and duplicate sequences` — `tests/restore-confirmation.test.js` | pass | pass | **fail — Finding 4** |
| Crash recovery | A crashed transaction converges without repeating a destination replacement; conflicting evidence demands owner intervention | `recoverRestoreTransactions` — `continuity/internal/restore/recovery.js` | `recovers idempotently after ${state} without repeating replacement`; `reclaims the abandoned lock and converges`; `requires owner intervention when post-rename destination bytes changed` — `tests/restore-recovery.test.js`; `rejects a well-formed foreign-owner lock during recovery (fail-closed, no reclaim)` — `tests/trust-crash.test.js` | pass | pass | **fail — Finding 4** |
| **Crash recovery reachability** | Recovery runs in the product, before any new apply transaction can begin | `recoverRestoreTransactions` call sites — `continuity/index.js` | `gives recoverRestoreTransactions at least one real non-test caller`; `runs recovery before a new apply transaction can begin`; `keeps the recover verb non-destructive and unable to start a transaction` — `tests/restore-boundary.test.js`; `converges a SIGKILL at ${boundary} before a new apply may begin`; `never repeats a destination replacement across repeated CLI recovery`; `leaves a destination changed after the committed replacement untouched` — `tests/restore-recovery-cli.test.js` | pass | pass | **fail — Finding 4** |
| **Recovery lock policy** | Only an authenticated, own-transaction, provably-dead lock is reclaimed; never by age | `classifyLockLiveness` — `continuity/internal/restore/recovery.js` | `classifies liveness by ownership and process state, never by age`; `refuses to reclaim a lock held by a live process`; `fails closed on a malformed, unauthenticated, or foreign lock`; `does not touch a lock belonging to a different transaction` — `tests/restore-recovery-cli.test.js` | pass | pass | **fail — Finding 4** |
| Package boundary | No writer is exported, deep-importable, or reachable through an exported object | `isSlotAuthoritative` — `continuity/trust-store.js` | `requirement 1 — exposes no new public export`; `requirement 2 — refuses a deep import of every writer module`; `requirement 9 — exposes no mutation primitive through an exported object`; `fails the boundary when the export map exposes a writer` — `tests/restore-boundary.test.js`; `does not expose a package-root entry point` — `tests/trust-api-boundary.test.js` | pass | pass | **fail — Finding 4** |
| CLI boundary | Only `trust` and `restore` reach a mutation entry point, only interactively, with typed exits | `trustFromCli` — `continuity/index.js` | `requirement 8 — only the CLI entry module imports a mutation entry point`; `requirement 8 — routes exactly two subcommands into the mutation handlers` — `tests/restore-boundary.test.js`; `refuses noninteractive stage with exit 4 before config, recall, or mutation`; `refuses noninteractive apply with exit 4 before candidate lookup or mutation`; `rejects aliases, options, unsupported slots, and malformed arity` — `tests/restore-cli.test.js` | pass | pass | **fail — Finding 4** |
| **Operator documentation** | Every documented claim matches the code; no documented command the CLI would reject | `Owner authority commands` — `noosphere-mcp/README.md` | `documents every owner authority command, and only real ones`; `documents exit codes 0 through 4 exactly as the code maps them`; `documents the seven-day retention, and that retention is not permission`; `documents crash recovery, the lock policy, and owner intervention`; `states the absence of every bypass, and no operator file contradicts it`; `shows no authority command the CLI would reject`; `documents the accepted PTY-relay residual` — `tests/operator-docs.test.js` | pass | pass | **fail — Finding 4** |
| Platform boundary | One canonical principal per physical tree; a fixed destination no alias can redirect; unsafe paths fail closed | `fixedDestination` — `continuity/internal/restore/apply-service.js` | `treats a canonical tree as ONE principal even under an aliased path`; `cannot be forked or selected by the process environment` — `tests/trust-project-binding.test.js`; `treats an unsafe (symlink) lock path as fail-closed, not absent` — `tests/trust-crash.test.js`; `refuses a symlinked slot FILE, whatever it points at` — `tests/slot-source-safety.test.js`; `WINDOWS ACL: MCP ACP, execution, sync, and CSP writes use the exact SID DACL` — `tests/windows-acl.test.js` | partial — the Windows ACL case is `not applicable: Windows-only exact SID ACL coverage` | partial — same skip | **not reached — the job fails earlier, Finding 4** |

Rows in **bold** are new in this remediation round.

## 3. The seven ship-blocking conditions

The gate fails by direct assertion, not by evidence reference, if any of these
becomes true. Each was mutation-tested; see §7.

| Condition | Gate assertion | Result |
|---|---|---|
| An authority mutation path becomes public | `fails if any authority mutation path becomes public` | not present |
| A deep import succeeds | `fails if any deep import succeeds` | not present |
| An MCP endpoint reaches a writer | `fails if any MCP endpoint reaches a writer` | not present |
| An API bypass appears | `fails if any API bypass appears` | not present |
| A `--yes` path appears | `fails if any --yes path appears` | not present |
| An environment bypass appears | `fails if any environment bypass appears` | not present |
| A config bypass appears | `fails if any config bypass appears` | not present |

## 4. Production recovery call graph

Finding 1 is closed. `recoverRestoreTransactions` has two production call sites,
both in the restore CLI handler, and no others anywhere in the repository.

```text
noosphere restore apply <candidate-id>
  └─ continuity/index.js :: restoreFromCli
       ├─ recoverRestoreTransactions({ projectRoot })        ← FIRST, always
       │    └─ listApplyJournals
       │         └─ per unfinished journal: recoverOne
       │              ├─ assertCompleteChain  (the recovery final barrier)
       │              │    ├─ store.readProjectBinding / canonicalProjectIdentityDigest
       │              │    ├─ showRestoreCandidate      → candidate ↔ journal
       │              │    ├─ readConfirmation          → spent by THIS transaction
       │              │    └─ store.inspectLock         → authenticate, then
       │              │         └─ classifyLockLiveness → abandoned | live | ambiguous
       │              ├─ fs.rm(staleLockPath, { force: false })   ← only if abandoned
       │              ├─ store.acquireLock
       │              ├─ readApplyJournal               ← re-read UNDER the lock
       │              └─ advance
       │                   ├─ prepared | temporary-written  → discardTemporary → failed
       │                   ├─ destination-replaced          → verify live bytes ==
       │                   │                                  authenticated replacement,
       │                   │                                  else OWNER_INTERVENTION
       │                   ├─ commitRestoreReceipt
       │                   ├─ commitConsumedMarker
       │                   └─ appendApplyJournalState('complete')
       └─ applyRestoreCandidate({ projectRoot, candidateId })   ← only after the above

noosphere restore recover
  └─ continuity/index.js :: restoreFromCli
       └─ recoverRestoreTransactions({ projectRoot })        ← same pass, alone
```

Reachability facts, all asserted:

- Exactly one non-test importer of `recovery.js`: `continuity/index.js`.
- Exactly two call sites, both enclosed by `restoreFromCli`.
- The pre-apply call is the statement immediately preceding
  `applyRestoreCandidate`, with no awaited operation between them.
- `restore recover` cannot reach `stageRestoreCandidate`,
  `applyRestoreCandidate`, `approveSlot`, `revokeSlot`, or
  `migrateTrustInventory`, and takes no argument, so it can neither select nor
  create a transaction.
- `recoverRestoreTransactions` is not in the export map, is not deep-importable,
  and is absent from `noosphere-continuity/trust-store`.

## 5. Lock recovery policy

A crash leaves the slot lock held. Before this round, recovery required the lock
to be absent, so a SIGKILLed process's lock hid its transaction permanently. The
policy now distinguishes three outcomes, and only one permits a reclaim.

**Step 1 — ownership, or refusal.** `store.inspectLock` is unchanged: it throws
for a lock that is not a regular file, cannot be securely read, is not JSON, has
a malformed token/MAC/field set, fails MAC verification over the slot-lock
domain, or belongs to another project identity, identity digest, owner scope,
machine key, or slot. Every one becomes
`ERR_RESTORE_OWNER_INTERVENTION_REQUIRED`, and the file is left exactly as found.

**Step 2 — the lock must be this transaction's.** An authenticated lock whose
`transactionId` differs from the journal being recovered is refused.

**Step 3 — liveness, by `classifyLockLiveness`.** Exactly one signal:

| `kill(pid, 0)` | Verdict | Effect |
|---|---|---|
| `pid` not a positive integer | `ambiguous` | refuse |
| succeeds | `live` | refuse |
| throws `EPERM` (exists, other user) | `live` | refuse |
| throws `ESRCH` | `abandoned` | reclaim |
| any other errno | `ambiguous` | refuse |

**There is no clock- or uptime-derived signal, by correction.** An earlier
version of this round also treated "the lock predates the machine's current
boot" as abandonment, on the stated reasoning that a wall clock could only cost
a fail-closed refusal. **That reasoning was wrong**, and hostile review caught
it. A clock that jumps *forward* — NTP correction, VM resume, a container
inheriting a skewed host clock — makes a **live** lock's `startedAt` older than
uptime, so it was declared abandoned and reclaimed out from under a running
transaction. That is fail-open. No wall-clock-derived boot identity avoids it: a
forward jump moves the derived boot time by the same amount. The signal was
removed rather than patched, which also removed the `os.uptime()` call that
throws `EPERM` under some sandbox and container profiles (21 failures in the
reviewer's run).

The accepted cost: after a reboot, a dead transaction's PID may be reused by an
unrelated live process, and recovery then reports `live` indefinitely. That is
fail-closed and visible — exit 4 naming the PID, and the owner can clear the lock
once they have confirmed it stale. Matching the Phase 4A stance: never reclaim on
a guess.

**Age is never a reason.** No timeout, no staleness window, no mtime comparison.

**Step 4 — identity-checked reclaim.** Removing by path alone was a race: between
the verdict and the removal, a competitor can clear the dead lock and take its
own, and a path-based `rm` would delete a **live** lock while its owner believes
it holds one. `reclaimAbandonedLock` re-identifies the file immediately before
removal — same inode, device and size, same authenticated bytes, same
transaction, still abandoned — and anything else fails closed. A lock already
cleared by someone else returns `false` rather than refusing.

*Residual, stated rather than hidden:* Node offers no `funlinkat`, so a window
remains between the final check and `unlink`. It is far smaller than the
verdict-to-removal window it replaces, and a competitor that loses this way still
detects it: `release()` compares lock tokens and refuses with
`trust-lock-not-owner` rather than continuing silently.

**Step 5 — re-read under the lock.** The journal is re-read after the lock is
held, and recovery refuses if it advanced while recovery was starting.

## 6. CLI recovery behaviour

| Situation | `restore recover` | `restore apply <id>` |
|---|---|---|
| No unfinished transaction | exit 0, `No restore transaction needed recovery.` | proceeds to the apply ceremony |
| Unfinished transaction, lock abandoned | exit 0, converges, prints the transaction and outcome | converges first, then proceeds |
| Already complete | exit 0, byte-identical output, no journal fact appended | proceeds |
| Lock held by a live process | exit 4, lock untouched | exit 4, apply never starts |
| Malformed / unauthenticated / foreign lock | exit 4, lock untouched | exit 4, apply never starts |
| Lock belongs to another transaction | exit 4, lock untouched | exit 4, apply never starts |
| Destination changed after the committed replacement | exit 4, destination untouched | exit 4, apply never starts |
| Piped stdin | works — no terminal required | exit 4 at the TTY gate, **after** recovery has run |

Convergence per journal state, none of which ever replaces a destination twice:

| Journal state at crash | Recovery outcome | Destination |
|---|---|---|
| `prepared` | discard temporary, candidate `failed` | unchanged |
| `temporary-written` | discard temporary, candidate `failed` | unchanged |
| `destination-replaced` | commit receipt + consumed marker | already replaced, verified, not rewritten |
| `receipt-committed` | commit consumed marker | already replaced, verified, not rewritten |
| `consumed-marker-committed` | append `complete` | already replaced, verified, not rewritten |

`restore recover` is non-destructive by construction: every write it performs is
one an authenticated journal already committed to. It cannot stage, approve,
revoke, or start a transaction, and it does not weaken the automatic pre-apply
pass — both call the same function, and the pre-apply ordering is asserted
independently.

## 7. Mutation results

Twelve mutations across three rounds. Every one was made real, run, and reverted;
`git diff --check` is silent and the tree carries only the intended files.

### Export-map and writer boundary

| # | Mutation | Failures | Caught by |
|---|---|---|---|
| A | Add `"./restore-apply"` to the export map | 3 | `requirement 1 — exposes no new public export`; `fails the boundary when the export map exposes a writer`; `keeps the test-only authority harness out of the packed package` |
| B | `export { approveSlot }` from the public entry | 6 | `requirement 1`; `requirement 8 — only the CLI entry module imports a mutation entry point`; `requirement 9 — re-exports no writer module through a barrel`; the mutation harness; `resolves the supported entry point from ESM and CommonJS`; `is imported only by the CLI and migration ceremony` |
| C | Publish the receipt writer at its own deep path | 4 | `requirement 1`; `requirement 2 — refuses a deep import of every writer module`; the mutation harness; the pack test |

### Production recovery (this round)

| # | Mutation | Failures | Dedicated regression |
|---|---|---|---|
| 1 | Remove the pre-apply `recoverRestoreTransactions` call | 7 | `gives recoverRestoreTransactions at least one real non-test caller`; `runs recovery before a new apply transaction can begin`; `converges a SIGKILL at ${boundary} before a new apply may begin` (×5) |
| 2 | Move recovery **after** `applyRestoreCandidate` | 6 | `runs recovery before a new apply transaction can begin`; `converges a SIGKILL at ${boundary} before a new apply may begin` (×5) |
| 3 | Bypass the recovery final barrier (`assertCompleteChain`) | 27 | every CLI recovery test, every lock-policy test, and every in-process recovery test |
| 4 | Delete a held lock unconditionally | 2 | `refuses to reclaim a lock held by a live process`; `does not touch a lock belonging to a different transaction` |
| 5 | Repeat the rename during recovery | 3 | `recovers a SIGKILL at temporary-written through \`noosphere restore recover\``; `converges a SIGKILL at temporary-written before a new apply may begin`; `SIGKILL at temporary-written: reclaims the abandoned lock and converges` |

### Conformance gate and documentation

| # | Mutation | Failures | Caught by |
|---|---|---|---|
| D | `process.env.NOOSPHERE_SKIP_RECEIPT` in `commitRestoreReceipt` | 1 | `fails if any environment bypass appears` |
| E | Import `readProjectConfig` into `apply-service.js` | 1 | `fails if any config bypass appears` |
| F | Add `--yes` handling to `trustFromCli` | 1 | `fails if any --yes path appears` |
| G | Rename an evidence test case | 1 | `verifies receipt semantics` |
| H | Change a documented fixed destination | 1 | `shows no authority command the CLI would reject` |
| I | Change the documented retention to thirty days | 1 | `documents the seven-day retention, and that retention is not permission` |
| J | Document a `restore purge` verb that does not exist | 2 | `documents every owner authority command, and only real ones`; `shows no authority command the CLI would reject` |

### Field splicing and concurrency (Task 9 Steps 3–4)

| # | Mutation | Failures | Dedicated regression |
|---|---|---|---|
| K | Let `verifyRecord` accept any record carrying a `slot` or `candidateId` without checking the MAC | 4 | all three splicing cases, plus `requires the stored domain to equal the independently supplied domain` |
| L | Drop the same-generation guard from `commitTransaction` | 1 | `refuses a second commit against an already-spent observed generation` |
| M | Drop the same-generation guard from `commitRevocation` | 1 | same |
| N | Make the slot lock advisory instead of exclusive | 4 | `lets exactly one transition commit from one observed generation`; `never reuses a generation across a burst of racing approvals`; `never lets a racing approval bypass a tombstone`; `races per-slot migration approval against a direct approval` |

Mutation L is why the concurrency suite has two layers. The concurrent races are
serialized by the slot lock, so dropping the generation guard left them all
green — the lock was hiding it. `refuses a second commit against an already-spent
observed generation` closes that hole by committing twice in sequence from one
observation, with no lock contention at all, which only the guard can refuse.

The export-map harness is permanent, not a one-off: `restore-boundary.test.js`
copies the package to a temporary directory, asserts the **unmutated** copy
passes — so a later failure cannot be a broken harness — then applies mutations A
and B to the copy and requires both to be caught.

## 8. Boundary inventory

Fourteen writer modules, all internal, all deep-import-refused. The
machine-readable form is `noosphere-mcp/tests/helpers/writer-surface.js`, which
the boundary suite and the conformance gate both consume.

| Category | Module | Writers | Public | Deep import | Reachable from |
|---|---|---|---|---|---|
| Approval | `internal/approval-service.js` | `approveSlot` | no | refused | `index.js`, `migration-service.js` |
| Revocation | `internal/revocation-service.js` | `revokeSlot` | no | refused | `index.js` |
| Migration | `internal/migration-service.js` | `migrateTrustInventory` | no | refused | `index.js` |
| Restore staging | `internal/restore/candidate-store.js` | `stageRestoreCandidate`, `markApplyInProgress`, `consumeCandidate`, `cleanupExpiredCandidates` | no | refused | `index.js`, apply, recovery |
| Restore apply | `internal/restore/apply-service.js` | `applyRestoreCandidate` | no | refused | `index.js` |
| Receipt | `internal/restore/receipt-store.js` | `commitRestoreReceipt` | no | refused | apply, recovery |
| Consumed marker | `internal/restore/receipt-store.js` | `commitConsumedMarker` | no | refused | apply, recovery |
| **Recovery** | `internal/restore/recovery.js` | `recoverRestoreTransactions` | no | refused | **`index.js` — `restore apply` pre-pass and `restore recover`** |
| Journal | `internal/restore/apply-journal.js` | `createApplyJournal`, `appendApplyJournalState` | no | refused | apply, recovery |
| Confirmation | `internal/restore/confirmation-store.js` | `issueConfirmation`, `confirmContext`, `spendContext` | no | refused | apply |
| State machine | `internal/restore/state-machine.js` | `createStateMachine`, `transitionStateMachine` | no | refused | journal, candidate, confirmation |
| Format-2 store | `internal/trust-format-v2.js` | `createFormatV2Store` (facade: `commitApproval`, `commitRevocation`, `commitTransaction`, `recover`, `createProjectBinding`, `acquireLock`) | no | refused | internal graph, `trust-store.js` read path |
| Trust primitives | `trust-store-internal.js` | `putSlotRecord`, `ensureProjectIdentity`, `ensureMachineKey` | no | refused | internal graph |

Surfaces scanned for a writer import, all clean: MCP (`noosphere-mcp/mcp-server`,
`noosphere-local-mcp/{bin,src}`, `noosphere-remote-mcp/{core,contracts}`,
`noosphere-remote-mcp-server/src`), lifecycle (including the three platform
services), hooks, the managed adapter blocks emitted by `writeAgentAdapters` and
`writeMcpConfigs`, the shipped MCP configuration JSON, and `noosphere-relayer`.

CLI mutation surface, exhaustive:

```text
noosphere trust migrate
noosphere trust approve  <master-prompt|instructions|baseline>
noosphere trust revoke   <master-prompt|instructions|baseline>
noosphere restore stage  <master-prompt|instructions|baseline>
noosphere restore apply  <candidate-id>
noosphere restore recover
```

`restore list` and `restore show <candidate-id>` are the only other restore
verbs; neither mutates.

## 9. Exported surface inventory

```json
"exports": {
  "./trust-store": "./continuity/trust-store.js",
  "./package.json": "./package.json"
}
```

`noosphere-continuity/trust-store` exports exactly five names:

| Name | Kind | Can it mutate authority? |
|---|---|---|
| `isSlotAuthoritative` | async function | no — answers a question; returns `false` on every failure at every layer |
| `TRUST_SLOTS` | frozen array | no |
| `PHASE1_NORM_ALGO` | string constant | no |
| `PHASE1_NORM_VERSION` | number constant | no |
| `TrustStoreError` | error class | no |

Verified at head `80dcf16` against a real packed and installed tarball
(`noosphere-continuity-2.4.0.tgz`, 192 KB, no `tests/`): all thirteen writer
module paths and the package root are refused with
`ERR_PACKAGE_PATH_NOT_EXPORTED` from both ESM `import` and CommonJS
`require.resolve`, and `recoverRestoreTransactions` is absent from the public
module. `recovery.js` does ship — the CLI needs it — which is exactly why the
export map, not the file list, is the boundary.

## 10. Environment and configuration reachability

Named environment variables reachable from the entire authority graph
(`continuity/internal/**`, `continuity/trust-store-internal.js`,
`continuity/trust-store.js`), exhaustive:

| Variable | Effect | Can it make a decision more permissive? |
|---|---|---|
| `NOOSPHERE_HOME` | selects where owner-local trust state lives | no — a wrong value yields no current state, which fails closed to unauthenticated |
| `NOOSPHERE_OWNER_SCOPE` | selects whose owner scope the state belongs to | no — a foreign scope fails closed |

No authority module reads project configuration. The single `loadConfig` call in
`restoreFromCli` builds the recall transport URL, whose output is staged as
untrusted candidate bytes.

## 11. CLI exit codes

| Exit | Meaning | Observed case |
|---|---|---|
| 0 | success | `restore list` on an empty store; `restore recover` with nothing to recover |
| 1 | unexpected defect | `noosphere refresh` in an uninitialized project |
| 2 | usage error | `trust bogus`; `restore show <non-canonical id>` |
| 3 | owner refusal | `trust approve master-prompt` under a genuine PTY with the wrong phrase |
| 4 | security refusal | `trust approve/revoke/migrate`, `restore stage/apply` with piped stdin; `restore recover` against a live, unprovable, or conflicting lock |

Exit 3 was produced through a real PTY, not a simulated TTY.

## 12. Executed gates

### Local — macOS 26.5.2 arm64, Node v24.12.0

| Gate | Result |
|---|---|
| Focused SEC-05 Phase 4C shard (17 files) | **182 tests, 181 pass, 0 fail, 1 skip** |
| Full MCP suite (`npm test`) | **720 tests, 716 pass, 0 fail, 4 skip** |
| Secure filesystem (`noosphere-secure-fs npm test`) | **50 tests, 49 pass, 0 fail, 1 skip** |
| Writer boundary (`restore-boundary` + `trust-api-boundary`) | **30 pass, 0 fail** |
| Conformance gate | **25 pass, 0 fail** |
| Mutation harness (in-suite, control + 2 mutants) | pass |
| npm pack → install → probe | **0 reachable writers** |

### Local — Linux, `node:22` container

| Gate | Result |
|---|---|
| Focused SEC-05 Phase 4C shard | **182 tests, 182 pass, 0 fail, 0 skip** |

### CI run 30373372871, head `80dcf16`

| Job | `npm run check` | `npm run test:security` | Phase 4C shard | Verdict |
|---|---|---|---|---|
| noosphere-mcp / ubuntu-latest | 721 tests, 718 pass, 0 fail, 3 skip | 133 tests, 129 pass, 0 fail, 4 skip | 183 tests, 183 pass, 0 fail, 0 skip | **pass** |
| noosphere-mcp / macos-latest | 721 tests, 717 pass, 0 fail, 4 skip | 133 tests, 129 pass, 0 fail, 4 skip | 183 tests, 182 pass, 0 fail, 1 skip | **pass** |
| noosphere-mcp / windows-latest | **721 tests, 675 pass, 34 fail, 12 skip** | **not reached** | **not reached** | **fail — Finding 4** |
| noosphere-relayer / ubuntu, macos, windows | — | — | — | pass |

Every skip on Linux and macOS is named and platform-inapplicable:

- `WINDOWS ACL: MCP ACP, execution, sync, and CSP writes use the exact SID DACL`
- `WINDOWS ACL: MCP repairs a legacy execution file before parsing it`
- `WINDOWS ACL: credential migration and relayer authority state use exact SID DACLs`
- `preserves a protected native Windows DACL across replacement`
- macOS only: `discards input typed before its prompt was displayed`
  (`needs script(1) with -c`; the case executes on Linux)

No `listen EPERM` failure occurred on any runner, so no result is
sandbox-degraded.

### Windows: executed, and failing

The Windows job ran to completion at head `1dd5466` and **failed**: 721 tests,
675 pass, **34 fail**, 12 skip. **No Windows cell in §2 may be read as passing.**

Findings 5 and 6 are confirmed closed by this run: `spawn script ENOENT` and
`ERR_UNSUPPORTED_ESM_URL_SCHEME` no longer appear at all, and the genuine-PTY
test reports the named skip `not applicable: no PTY allocator on Windows
runners`.

**Every one of the 34 failures is Finding 4 or a consequence of it.** They fall
in exactly three files — `restore-apply`, `restore-recovery`, and
`restore-recovery-cli` — with four error strings:

| Error | Count | Relationship to Finding 4 |
|---|---|---|
| `restore destination validation failed: state-acl-broad` | 3 | Finding 4 directly |
| `restore apply journal is missing` | 6 | the crash child cannot complete an apply, so no journal is ever written |
| `a real crash must leave the slot lock held` | 5 | same — no apply means no lock |
| `Expected "actual" to be strictly unequal to: null` | 5 | the same absent lock, asserted from the other direction |

What **does** pass on Windows, and is therefore genuinely verified there:

- the whole writer-surface boundary suite, including the export map, every
  deep-import refusal, and the packed-tarball check;
- the conformance gate, all fifteen properties;
- the operator-documentation suite;
- the trust cutover, revocation, migration, crash, project-binding, restore CLI
  grammar, restore staging, and confirmation suites;
- the three `WINDOWS ACL:` exact-SID DACL cases — these **executed and passed**,
  they did not skip.

Because the job aborts inside `npm run check` with exit 1, the later
`npm run test:security` step and the Phase 4C shard **never ran**. Of the six
Windows-native cases release requires:

| Case | Status |
|---|---|
| exact SID DACL handling | **executed, pass** (3 cases in `tests/windows-acl.test.js`) |
| protected-DACL preservation | **not reached** — lives in `noosphere-secure-fs`, only run by `test:security` |
| rename over an open destination | **not reached** |
| sharing violation | **not reached** |
| durable replacement | **not reached** |
| reparse-point refusal | **not reached** |

The five unreached cases are unreached because an earlier step fails, not because
they skipped:

- exact SID DACL handling on ACP, execution, sync, and CSP writes
- protected-DACL preservation across a replacement
- rename over an open destination
- sharing-violation retry and its bounded budget
- durable replacement
- reparse-point refusal

Windows verification is **not** complete if those tests skip rather than run, and
it is not complete now: five of the six have neither run nor been reported. The
`test:security` shard is the gate that forces them to execute on
`windows-latest`; a Windows job that reports them as `# SKIP` is a failed
verification, not a pass — and a Windows job that aborts before reaching them, as
this one does, is not evidence of anything. Fixing Finding 4 is what unblocks
their execution.

## 13. Findings

### Finding 1 — recovery unreachable in production — **CLOSED** (`3d60be8`)

`recoverRestoreTransactions` had no production caller. It is now invoked before
every `restore apply` and by `noosphere restore recover`. See §4, §5, §6, and
mutations 1–5 in §7. The specification was not narrowed.

### Finding 2 — operator documentation missing — **CLOSED** (`f35f0f8`)

`noosphere-mcp/README.md` now carries the complete operator reference, verified
against the code by `tests/operator-docs.test.js`. See mutations H–J in §7.

While writing it, the root `README.md` was found to document a bulk
`noosphere restore` that Phase 4C had removed — an operator following it would
have received a usage error. Corrected, and the drift class is now covered by
`shows no authority command the CLI would reject`.

### Finding 3 — type-ahead was masking a Linux-only red job — **CLOSED** (`80dcf16`)

The genuine-PTY migration test failed on `ubuntu-latest` only. The driver wrote
both confirmation phrases before either prompt was displayed; the second slot was
refused with exit 3.

The refusal is correct product behaviour: each prompt reads through a fresh
reader, so input typed before a prompt was shown is discarded with the reader
that buffered it — a phrase cannot answer a question the owner has not yet been
asked. The harness was wrong, not the ceremony. It now waits for each prompt, and
the discard behaviour is pinned by its own test so a refactor to one shared stdin
reader would fail loudly instead of silently weakening the ceremony.

### Finding 4 — owner-only ACL semantics applied to a repository destination — **FIXED, verified on Windows**

`inspectOwnerOnlyDestination` asked two different questions on the two platforms:

| Platform | Refuses when | A normal repository file |
|---|---|---|
| POSIX | group or other has **write** (`mode & 0o022`) | 0644 passes |
| Windows | the DACL is anything other than exactly `{SYSTEM, Administrators, owner}` with no inherited ACEs | **failed** — `state-acl-broad` |

The restore destination is a **repository** file. `atomicRepositoryWrite`
confirms the intent: on Windows it copies the destination's existing DACL
forward, on POSIX it carries the mode forward. Every real `.noosphere/*.md`
carries inherited ACEs, so `noosphere restore apply` could not succeed on Windows
at all — `ERR_RESTORE_FINAL_BARRIER: state-acl-broad`, 6 of 8 `restore-apply` and
all 11 `restore-recovery` cases.

**Fixed in `db164e3`.** Windows now asks the POSIX question. A new `write-sids`
helper action reports facts only — the owner SID, then every distinct SID holding
a write-ish right (`WriteData`, `AppendData`, `WriteAttributes`,
`WriteExtendedAttributes`, `Delete`, `DeleteSubdirectoriesAndFiles`,
`ChangePermissions`, `TakeOwnership`) through an **Allow** ACE. Deny ACEs are
skipped, since a Deny can only remove access. Inherited ACEs are included:
inheritance was never the hazard, foreign write is. `verifyNoForeignWriteWindows`
holds the policy in JavaScript, where it is testable without a Windows host —
every reported writer must be the owner, SYSTEM, or Administrators. The two
built-ins are permitted for the same reason POSIX ignores root: they can take
ownership regardless. Anything unparseable is `state-acl-readback-failed`,
because an unreadable answer is an unanswered question rather than an absence of
foreign writers.

This did **not** relax owner-only state. `verifyOwnerOnlyWindows` had exactly one
caller — this destination inspector — and owner-local state gets its exact
protected DACL from the helper's own `write`/`read`/`repair` actions, unchanged.
The restore temporary is still written and verified by
`writeOwnerOnlyFileExclusive` with the exact owner-only DACL; it passes the new
check trivially.

**Verified on the `windows-latest` runner** (CI run 30384491181, head `db164e3`):
`state-acl-broad` appears **zero** times, and no destination was refused as
`state-destination-foreign-write`. Restore-apply cases that previously failed now
pass, including `detects a destination race after the barrier before creating the
temporary file`. The PowerShell `write-sids` action executed on a real Windows
host without error.

That run still fails, but on a different cause — see Finding 7.

### Findings 8, 9, 10 — hostile review of the lock policy — **CLOSED**

An independent hostile review at head `3f23c7b` returned REQUEST CHANGES with
three POSIX-independent findings against the recovery lock policy introduced in
this round. All three were confirmed and fixed; none was a false positive.

**Finding 8 — path-based lock-reclamation race.** The reclaim removed the lock by
path. Between the liveness verdict and the `rm`, a competitor could clear the
dead lock and acquire its own, and the reclaim would then delete a **live** lock
while its owner believed it held one. Fixed by `reclaimAbandonedLock`, which
re-identifies the file (inode, device, size, authenticated bytes, transaction,
liveness) immediately before removal. The remaining sub-`unlink` window is stated
in §5 rather than papered over.

*Note on the regression:* driving this through the CLI does **not** reach the
race — the barrier rejects a foreign `transactionId` first, so a path-based
reclaim still passed every CLI-level test. `reclaimAbandonedLock` is therefore
exported and tested directly. Without that, the fix would have looked verified
and been untested.

**Finding 9 — forward-clock live-lock misclassification.** The uptime signal was
documented as fail-closed-only. It was not: a forward clock jump makes a live
lock read as abandoned. Signal removed entirely; see §5.

**Finding 10 — unhandled `os.uptime()` failure.** `uv_uptime` returns `EPERM`
under some sandbox and container profiles, and the call sat in a default
parameter, so it threw inside the classifier (21 failures in the reviewer's run).
Removed with Finding 9. The classifier now makes no host call that can refuse
other than `kill(pid, 0)`, whose every unexpected errno is already `ambiguous`.

Mutation-checked: reintroducing the path-based reclaim kills 2 tests;
reintroducing the uptime signal kills 3.

### Findings 11–14 — continued hostile review, recovery semantics — **CLOSED**

The reviewer's continued POSIX-only pass reproduced four further defects with
standalone owner-local probes. All four were confirmed and fixed.

**Finding 11 — a committed rename with no journal event was recorded as failed.**
The atomic destination rename and the `destination-replaced` journal event are
two steps. A crash between them left the journal at `temporary-written` while the
destination already held the replacement. Recovery labelled the transaction
`discarded`, committed outcome `failed`, and consumed the candidate as failed —
telling the owner nothing happened while the new bytes sat on disk, and leaving
the audit record contradicting the filesystem.

Recovery now observes the destination at `prepared`/`temporary-written` and
requires it to be exactly one of the two states the journal authenticated: the
recorded pre-state, or the replacement it committed to. If it holds the
replacement and the deterministic temporary is gone, the rename committed and
recovery converges forward through `destination-replaced`. Anything else is owner
intervention. This is not destination bytes selecting a permissive branch — both
branches are authenticated, and a third value refuses.

**Finding 12 — candidates stranded with no journal.** `applyRestoreCandidate`
spends the confirmation, marks the candidate `apply-in-progress`, and only then
creates the journal. A crash in that window left a candidate that no listing
enumerated: `listRestoreCandidates` returns only ACTIVE candidates and recovery
walked only journals, so the candidate could never be applied and never restaged.
`listApplyInProgressCandidates` (read-only) now enumerates them and
`releaseStrandedCandidate` consumes them as failed — after authenticating that
the confirmation is spent *by that transaction* and bound to that candidate and
payload. No journal means no destination was ever touched, so nothing else is
undone.

**Finding 13 — the recovery barrier ignored a moved manifest.** A transaction
confirmed against `pristine-unapproved` completed after the slot had been
approved: the owner authorised a replacement in one authority state and it landed
in another. `assertCompleteChain` now recomputes the manifest binding and refuses
unless it is canonically identical to the one the journal recorded.

**Finding 14 — the operator reference contradicted the product.** It claimed exit
3 and exit 4 both mean nothing was changed, while `restore apply` deliberately
runs mutating recovery *before* its terminal check — so a piped-stdin apply can
converge a crashed transaction and then exit 4. The reference now states that
explicitly, and `documents exit codes 0 through 4 exactly as the code maps them`
asserts both the disclosure and the code ordering it describes.

Mutation-checked: reverting Finding 11 kills 2 tests, Finding 12 kills 1, Finding
13 kills 1. Finding 12's negative case turned out to be unconstructible through
the production primitives — `markApplyInProgress` already refuses a transaction
that did not spend the confirmation — so that invariant is asserted instead, and
`releaseStrandedCandidate`'s own check is documented as defence in depth against
hand-edited owner-local state.

### Finding 7 — Windows restore apply is ~80 s per operation — **OPEN (performance)**

With Finding 4 fixed, the Windows restore path runs to completion for the first
time — and one `restore apply` takes about **80 seconds** on a CI runner
(`detects a destination race after the barrier before creating the temporary
file`: `duration_ms: 79460`, **passing**).

The cost is `powershell.exe` process startup. Every owner-only observation —
`inspectOwnerOnlyDestination`, every owner-only read and write — spawns the
helper script, and a single apply performs several: destination observation,
final-barrier re-observation, prepared destination, prepared temporary,
revalidation, commit. Cold-starting PowerShell on a Windows runner costs seconds
each. This is pre-existing Windows behaviour of the secure-fs helper, not
something the Finding 4 fix introduced; the fix merely made the path reachable
so the cost became visible.

Correctness is unaffected — the cases that complete pass. The failures it caused
were harness budgets: a 60 s crash-child `spawnSync` timeout and the 600 s
per-file node budget against eight ~80 s cases. Both were raised.

Not a release blocker: the feature works and fails closed. It is a real
user-facing Windows latency worth reducing. The obvious reduction is that
`inspectOwnerOnlyDestination` re-verifies the ACL of a temporary file that
`writeOwnerOnlyFileExclusive` created and verified microseconds earlier in its
own PowerShell invocation — a redundant spawn per replacement. Deliberately not
changed here: it is an optimisation to the security path and belongs in its own
review, not bundled into a correctness fix.

### Finding 5 — Windows PTY ceremony unverifiable — **OPEN (accepted residual)**

`requires distinct confirmations through a genuine PTY for two eligible slots`
previously failed on Windows with `spawn script ENOENT`. Windows runners have
neither `script(1)` nor `expect`, and Node cannot allocate a pseudo-terminal
without a native addon.

The test now skips on Windows with the named reason
`not applicable: no PTY allocator on Windows runners`, confirmed in CI run
30377401209, so the job reports the gap instead of a spurious red. **The migration ceremony's behaviour under a real
Windows terminal is unverified.** The TTY *refusal* is verified on every
platform by `checks both TTY streams before inventory or mutation`; what is not
verified is the interactive accept path on Windows.

### Finding 6 — boundary suite used an absolute path as an ESM specifier — **CLOSED, confirmed on Windows**

`classifies every export of every writer module` imported each writer module by
absolute path. On Windows Node reads `D:\...` as a URL with scheme `d:` and
throws `ERR_UNSUPPORTED_ESM_URL_SCHEME`. Now uses `pathToFileURL`. A test-only defect,
introduced in this workstream and caught by the first Windows run; the whole
boundary suite now passes on `windows-latest`.

## 14. Release gate

Release remains blocked until every one of these is true:

- [x] Finding 1 closed in the product path
- [x] Finding 2 documented and tested
- [x] Linux job passes
- [x] macOS job passes
- [x] Finding 4 fixed and verified on a real Windows runner
- [ ] **Windows job passes — see Finding 7 (harness budgets raised, re-run pending)**
- [ ] Windows-native cases actually execute rather than skip
- [ ] Finding 5 either closed or accepted as a documented residual
- [ ] Independent hostile review at the exact head finds no unresolved authority,
      recovery, replay, or destructive restore defect
- [ ] An approving review is submitted by someone other than the implementer

## 15. Hostile review request

The reviewer should be given:

1. The Phase 4C specification and the implementation plan
   (`docs/superpowers/plans/2026-07-27-sec-05-phase-4c.md`).
2. The complete commit range `d2992c3..f8c8689` (18 commits), and PR
   [#34](https://github.com/papmilan/noosphere/pull/34).
3. This conformance matrix, the production recovery call graph (§4), the lock
   policy (§5), and the boundary and export inventories (§8–§9).
4. The unresolved cells: **every Windows row in §2**, and the six Windows-native
   cases in §12 that have never executed.
5. Findings 1–4 in §13.

Specifically asked of the reviewer — try to break, not confirm:

- **Recovery reachability and ordering.** Find a path that starts an apply
  transaction without the recovery pre-pass, or that makes the pre-pass a no-op:
  a second entry point, an exception swallowed before it runs, a project root
  that resolves differently between the pre-pass and the apply.
- **The lock policy.** Attack `classifyLockLiveness`. PID reuse within one boot,
  a container or PID namespace where `kill(pid, 0)` lies, a clock moved forward
  so a live lock reads as pre-boot, `startedAt` shapes that parse but mean
  nothing, and the window between the liveness verdict and the `fs.rm`.
- **Recovery as a destructive primitive.** `restore recover` needs no terminal.
  Find any way to make it write a project file that an authenticated journal did
  not already commit to, or to make it remove a lock, temporary file, or
  candidate it must leave alone.
- **Cutover.** Find any path where format-1 state, a deleted manifest, a deleted
  binding, or a pre-4C format-2 record can still authorize bytes.
- **State machines.** Find a candidate, confirmation, or apply-journal transition
  reachable out of order, replayable, or rebindable across candidates, projects,
  or slots.
- **Final and recovery barriers.** Find a destination byte, filesystem race, or
  timing window that selects a branch after the owner confirmed.
- **Cross-domain matrix.** Attempt a splice that preserves a MAC while exchanging
  candidate, confirmation, manifest, receipt, consumed-marker, journal, binding,
  identity, slot, generation, or transaction fields across the twelve domains.
- **Windows.** Rename over an open destination, sharing violations, protected
  DACLs, reparse points, and 8.3 short names against the fixed destination and
  the deterministic temporary path.
- **Alternate writer surfaces.** Find any way — export map, deep import, MCP
  tool, hook, lifecycle service, adapter, relayer, environment variable, config
  key, or CLI flag — to reach a mutation primitive without the interactive owner
  ceremony. The twelve mutations in §7 show what the current gate catches; find
  one it does not.
- **The documentation.** Every claim in `noosphere-mcp/README.md` is a claim an
  operator will act on. Find one that is false.
- **Finding 4's blast radius.** `inspectOwnerOnlyDestination` is shared. Decide
  whether any OTHER caller is relying on owner-only ACL semantics that a
  POSIX-mirroring fix would relax, and whether the POSIX branch itself is right:
  it permits group/other **read** of an authority-capable slot, which is correct
  for a repository file but should be stated deliberately rather than inherited.
