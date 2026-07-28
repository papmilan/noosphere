# SEC-05 Phase 4C — Conformance Verification Record

Status: **not released.** Blocked on hostile security review and on the Linux and
Windows platform cells, which have no runner result yet.

This document is the traceable requirement-to-test matrix for SEC-05 Phase 4C,
plus the exact evidence produced while verifying it. Nothing here is inferred:
a platform cell is `pass` only where that platform's runner actually executed
the case, and `pending external runner` everywhere else.

## 1. Verified head

| Field | Value |
|---|---|
| Branch | `codex/sec-05-phase-4c1` |
| Commit range | `d2992c3..HEAD` (11 Phase 4C commits on top of `origin/main`) |
| Merge base | `d2992c3f1ac3fd10bbd0abb9e1192bdc7193a016` |
| Implementation head at time of audit | `20b07c041e091c87234c8e1303e3b8e4785410df` |
| Node | v24.12.0 |
| npm | 11.6.2 |
| Verification host | macOS 26.5.2, arm64 |

## 2. Conformance matrix

Implementation cells name an exact function and file. Test-evidence cells name
an exact test case. The gate in `noosphere-mcp/tests/phase4c-conformance.test.js`
asserts every cell in this table mechanically: if an implementation symbol or an
evidence case name disappears, the gate fails.

| Spec section | Invariant | Implementation | Test evidence | Linux | macOS | Windows |
|---|---|---|---|---|---|---|
| Authority cutover | Loading the dispatcher retires format 1 irreversibly; legacy state is inventory only | `isSlotAuthoritative` — `continuity/trust-store.js` | `makes a valid format-1 approval inert before migration inventory`; `keeps format 1 inert after Phase 4C manifest deletion`; `keeps format 1 inert after binding deletion or corruption` — `tests/trust-phase4c-cutover.test.js` | pending external runner | pass | pending external runner |
| Generations | Generations are append-only; a rolled-back or missing manifest is invalid, never permissive | `buildApprovedGeneration` — `continuity/internal/trust-generation.js` | `appends N+1 tombstone, is idempotent, and reapproves only at N+2`; `classifies missing or rolled-back manifests with generation artifacts as invalid` — `tests/trust-revocation.test.js`; `chains immutable events and rejects substitution or truncation` — `tests/trust-audit.test.js` | pending external runner | pass | pending external runner |
| Revocation | Tombstones are authenticated, canonically shaped, and domain-bound | `revokeSlot` — `continuity/internal/revocation-service.js` | `builds the one exact canonical tombstone shape`; `rejects forbidden, null, inherited, unknown, and omitted tombstone fields`; `quarantines a MAC-invalid tombstone and its authenticated incomplete journal` — `tests/trust-revocation.test.js`; `rejects every ordered cross-domain substitution` — `tests/trust-domain-separation.test.js` | pending external runner | pass | pending external runner |
| Migration | Every eligible slot requires a fresh owner approval; no legacy state is promoted | `migrateTrustInventory` — `continuity/internal/migration-service.js` | `requires a distinct normal approval for every eligible slot`; `never restarts invalid current Phase 4C history from legacy inventory`; `never prompts over a current authenticated tombstone`; `checks both TTY streams before inventory or mutation` — `tests/trust-migration.test.js` | pending external runner | pass | pending external runner |
| Restore staging | Staging authenticates a candidate and changes no project file and no authority state | `stageRestoreCandidate` — `continuity/internal/restore/candidate-store.js` | `stages one authenticated candidate without changing project files`; `fails closed on payload tampering and unsafe candidate-shaped entries`; `checks both TTY streams before recall or mutation` — `tests/restore-store.test.js`; `accepts only the four normative restore productions` — `tests/restore-cli.test.js` | pending external runner | pass | pending external runner |
| Restore apply | The final barrier completes before the first temporary write; destination races fail closed; authority is recomputed, never asserted | `applyRestoreCandidate` — `continuity/internal/restore/apply-service.js` | `runs the complete final barrier before the first temporary write`; `detects a destination race after the barrier before creating the temporary file`; `applies into a revoked slot without changing its tombstone or authority`; `recomputes authority from the live bytes and current manifest` — `tests/restore-apply.test.js` | pending external runner | pass | pending external runner |
| Receipts | A receipt is immutable, authenticated, and audit-only — it confers no authority | `commitRestoreReceipt` — `continuity/internal/restore/receipt-store.js` | `commits an immutable authenticated audit-only receipt` — `tests/restore-receipt.test.js` | pending external runner | pass | pending external runner |
| Consumed markers | A spent confirmation cannot be replayed, rebound, or rolled back | `commitConsumedMarker` — `continuity/internal/restore/receipt-store.js` | `commits an independent authenticated consumed marker and rejects tampering` — `tests/restore-receipt.test.js`; `spends the issued context after one wrong phrase and refuses replay`; `cannot bind one spent confirmation transaction to another candidate`; `rejects authenticated current-state rollback and duplicate sequences` — `tests/restore-confirmation.test.js` | pending external runner | pass | pending external runner |
| Crash recovery | A crashed transaction converges without repeating a destination replacement; conflicting evidence demands owner intervention | `recoverRestoreTransactions` — `continuity/internal/restore/recovery.js` | `recovers idempotently after ${state} without repeating replacement`; `fails closed on the held lock, then converges`; `requires owner intervention when post-rename destination bytes changed` — `tests/restore-recovery.test.js`; `rejects a well-formed foreign-owner lock during recovery (fail-closed, no reclaim)` — `tests/trust-crash.test.js` | pending external runner | pass (see Finding 1) | pending external runner |
| Package boundary | No writer is exported, deep-importable, or reachable through an exported object | `isSlotAuthoritative` — `continuity/trust-store.js` | `requirement 1 — exposes no new public export`; `requirement 2 — refuses a deep import of every writer module`; `requirement 9 — exposes no mutation primitive through an exported object`; `fails the boundary when the export map exposes a writer` — `tests/restore-boundary.test.js`; `does not expose a package-root entry point` — `tests/trust-api-boundary.test.js` | pending external runner | pass | pending external runner |
| CLI boundary | Only `trust` and `restore` reach a mutation entry point, only interactively, with typed exits | `trustFromCli` — `continuity/index.js` | `requirement 8 — only the CLI entry module imports a mutation entry point`; `requirement 8 — routes exactly two subcommands into the mutation handlers` — `tests/restore-boundary.test.js`; `refuses noninteractive stage with exit 4 before config, recall, or mutation`; `refuses noninteractive apply with exit 4 before candidate lookup or mutation`; `rejects aliases, options, unsupported slots, and malformed arity` — `tests/restore-cli.test.js` | pending external runner | pass | pending external runner |
| Platform boundary | One canonical principal per physical tree; a fixed destination no alias can redirect; unsafe paths fail closed | `fixedDestination` — `continuity/internal/restore/apply-service.js` | `treats a canonical tree as ONE principal even under an aliased path`; `cannot be forked or selected by the process environment` — `tests/trust-project-binding.test.js`; `treats an unsafe (symlink) lock path as fail-closed, not absent` — `tests/trust-crash.test.js`; `refuses a symlinked slot FILE, whatever it points at` — `tests/slot-source-safety.test.js`; `WINDOWS ACL: MCP ACP, execution, sync, and CSP writes use the exact SID DACL` — `tests/windows-acl.test.js` | pending external runner | partial — the Windows ACL case is `not applicable: Windows-only exact SID ACL coverage` and skipped here | pending external runner |

## 3. The seven ship-blocking conditions

The gate fails, by direct assertion rather than by evidence reference, if any of
these becomes true. Each was mutation-tested; see §6.

| Condition | Gate assertion | Result |
|---|---|---|
| An authority mutation path becomes public | `fails if any authority mutation path becomes public` | not present |
| A deep import succeeds | `fails if any deep import succeeds` | not present |
| An MCP endpoint reaches a writer | `fails if any MCP endpoint reaches a writer` | not present |
| An API bypass appears | `fails if any API bypass appears` | not present |
| A `--yes` path appears | `fails if any --yes path appears` | not present |
| An environment bypass appears | `fails if any environment bypass appears` | not present |
| A config bypass appears | `fails if any config bypass appears` | not present |

## 4. Boundary inventory

Every Phase 4C authority mutation primitive, its owning module, and its
reachability. The machine-readable form is
`noosphere-mcp/tests/helpers/writer-surface.js`, which the boundary suite and
the conformance gate both consume, so the two can never disagree.

| Category | Module | Writers | Public export | Deep import | Reachable from |
|---|---|---|---|---|---|
| Approval | `continuity/internal/approval-service.js` | `approveSlot` | no | refused | `continuity/index.js`, `migration-service.js` |
| Revocation | `continuity/internal/revocation-service.js` | `revokeSlot` | no | refused | `continuity/index.js` |
| Migration | `continuity/internal/migration-service.js` | `migrateTrustInventory` | no | refused | `continuity/index.js` |
| Restore staging | `continuity/internal/restore/candidate-store.js` | `stageRestoreCandidate`, `markApplyInProgress`, `consumeCandidate`, `cleanupExpiredCandidates` | no | refused | `continuity/index.js`, `apply-service.js`, `recovery.js` |
| Restore apply | `continuity/internal/restore/apply-service.js` | `applyRestoreCandidate` | no | refused | `continuity/index.js` |
| Receipt | `continuity/internal/restore/receipt-store.js` | `commitRestoreReceipt` | no | refused | `apply-service.js`, `recovery.js` |
| Consumed marker | `continuity/internal/restore/receipt-store.js` | `commitConsumedMarker` | no | refused | `apply-service.js`, `recovery.js` |
| Recovery | `continuity/internal/restore/recovery.js` | `recoverRestoreTransactions` | no | refused | **no production caller — see Finding 1** |
| Journal | `continuity/internal/restore/apply-journal.js` | `createApplyJournal`, `appendApplyJournalState` | no | refused | `apply-service.js`, `recovery.js` |
| Confirmation | `continuity/internal/restore/confirmation-store.js` | `issueConfirmation`, `confirmContext`, `spendContext` | no | refused | `apply-service.js` |
| State machine | `continuity/internal/restore/state-machine.js` | `createStateMachine`, `transitionStateMachine` | no | refused | `apply-journal.js`, `candidate-store.js`, `confirmation-store.js` |
| Format-2 store | `continuity/internal/trust-format-v2.js` | `createFormatV2Store` (facade methods `commitApproval`, `commitRevocation`, `commitTransaction`, `recover`, `createProjectBinding`, `acquireLock`) | no | refused | the internal authority graph and `trust-store.js` (read path only) |
| Trust primitives | `continuity/trust-store-internal.js` | `putSlotRecord`, `ensureProjectIdentity`, `ensureMachineKey` | no | refused | the internal authority graph |

Surfaces scanned for a writer import, all clean:

- MCP — `noosphere-mcp/mcp-server`, `noosphere-local-mcp/{bin,src}`,
  `noosphere-remote-mcp/{core,contracts}`, `noosphere-remote-mcp-server/src`
- Lifecycle — `noosphere-mcp/lifecycle` (including the three platform services)
- Hooks — `noosphere-mcp/hooks`
- Adapters — the managed blocks emitted by `writeAgentAdapters` and
  `writeMcpConfigs`, and the shipped MCP configuration JSON
- Relayer — `noosphere-relayer`

CLI mutation surface, exhaustive:

```text
noosphere trust migrate
noosphere trust approve  <master-prompt|instructions|baseline>
noosphere trust revoke   <master-prompt|instructions|baseline>
noosphere restore stage  <master-prompt|instructions|baseline>
noosphere restore apply  <candidate-id>
```

`noosphere restore list` and `noosphere restore show <candidate-id>` are the
only non-interactive restore verbs; neither mutates.

## 5. Exported surface inventory

The complete public surface of `noosphere-continuity@2.4.0`:

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

Verified against a real packed and installed tarball
(`noosphere-continuity-2.4.0.tgz`, 188 KB): all thirteen writer module paths and
the package root are refused with `ERR_PACKAGE_PATH_NOT_EXPORTED`, from both ESM
`import` and CommonJS `require.resolve`. The writer modules do ship — the CLI
needs them — which is exactly why the export map, not the file list, is the
boundary.

## 6. Mutation results

The boundary and the gate were mutation-tested by making each violation real,
running the suites, and reverting. A gate that has never failed is not evidence.

| # | Mutation | Suite result | Caught by |
|---|---|---|---|
| A | Add `"./restore-apply": "./continuity/internal/restore/apply-service.js"` to the export map | 3 failures | `requirement 1 — exposes no new public export`; `fails the boundary when the export map exposes a writer`; `keeps the test-only authority harness out of the packed package` |
| B | Append `export { approveSlot } from './internal/approval-service.js';` to `continuity/trust-store.js` | 6 failures | `requirement 1`; `requirement 8 — only the CLI entry module imports a mutation entry point`; `requirement 9 — re-exports no writer module through a barrel`; `fails the boundary…`; `resolves the supported entry point from ESM and CommonJS`; `is imported only by the CLI and migration ceremony` |
| C | Publish the receipt writer at its own deep path in the export map | 4 failures | `requirement 1`; `requirement 2 — refuses a deep import of every writer module`; `fails the boundary…`; `keeps the test-only authority harness out of the packed package` |
| D | Add `bypass = process.env.NOOSPHERE_SKIP_RECEIPT` to `commitRestoreReceipt` | 1 failure | `fails if any environment bypass appears` |
| E | Import `readProjectConfig` into `apply-service.js` | 1 failure | `fails if any config bypass appears` |
| F | Add `const assumeYes = remaining.includes('--yes')` to `trustFromCli` | 1 failure | `fails if any --yes path appears` |
| G | Rename the evidence case `commits an immutable authenticated audit-only receipt` | 1 failure | `verifies receipt semantics` |

All seven mutations were reverted; `git diff --check` is silent and the tree
carries only the intended new files.

The mutation harness is permanent, not a one-off: `restore-boundary.test.js`
copies the package into a temporary directory, asserts the **unmutated** copy
passes (so a later failure cannot be a broken harness), then applies mutations A
and B to the copy and asserts each is caught.

## 7. Environment and configuration reachability

Named environment variables reachable from the entire authority graph
(`continuity/internal/**`, `continuity/trust-store-internal.js`,
`continuity/trust-store.js`), exhaustive:

| Variable | Effect | Can it make a decision more permissive? |
|---|---|---|
| `NOOSPHERE_HOME` | selects where owner-local trust state lives | no — a wrong value yields no current state, which fails closed to unauthenticated |
| `NOOSPHERE_OWNER_SCOPE` | selects whose owner scope the state belongs to | no — a foreign scope fails closed (`fails closed when another owner scope tries to adopt the binding`) |

No authority module reads project configuration at all. The single
`loadConfig` call inside `restoreFromCli` builds the recall transport URL, whose
output is staged as untrusted candidate bytes and can never become authoritative
without a separate `noosphere trust approve`.

## 8. CLI exit codes

Observed directly against `continuity/index.js` at the verified head:

| Exit | Meaning | Observed case |
|---|---|---|
| 0 | success | `noosphere restore list` with an empty active store |
| 1 | unexpected defect | `noosphere refresh` in an uninitialized project |
| 2 | usage error | `noosphere trust bogus`; `noosphere restore show <non-canonical id>` |
| 3 | owner refusal | `noosphere trust approve master-prompt` under a genuine PTY, wrong confirmation phrase (`approval was not confirmed; nothing was changed`) |
| 4 | security refusal | `trust approve`, `trust revoke`, `trust migrate`, `restore stage` with a piped stdin |

Exit 3 was produced through a real PTY (`script`), not a simulated TTY.

## 9. Executed gates

| Gate | Command | Result |
|---|---|---|
| Focused SEC-05 Phase 4C | `node --test --test-concurrency=1 --test-timeout=600000` over the 15-file shard in §10 | **142 pass, 0 fail, 0 skip** |
| Full MCP suite | `cd noosphere-mcp && npm test` | **680 tests, 677 pass, 0 fail, 3 skip** |
| Secure filesystem | `cd noosphere-secure-fs && npm test` | **50 tests, 49 pass, 0 fail, 1 skip** |
| Boundary | `node --test tests/restore-boundary.test.js tests/trust-api-boundary.test.js` | **26 pass, 0 fail** |
| Conformance gate | `node --test tests/phase4c-conformance.test.js` | **22 pass, 0 fail** |
| npm pack verification | `npm pack` → extract → install into a bare consumer → probe every writer path | **0 reachable writers** |

Every skip is named and platform-inapplicable on this host:

- MCP suite (3): `WINDOWS ACL: MCP ACP, execution, sync, and CSP writes use the
  exact SID DACL`; `WINDOWS ACL: MCP repairs a legacy execution file before
  parsing it`; `WINDOWS ACL: credential migration and relayer authority state
  use exact SID DACLs` — all `# Windows-only exact SID ACL coverage`.
- secure-fs (1): `preserves a protected native Windows DACL across replacement`.

No `listen EPERM` failure occurred: this host permits localhost test listeners,
so the full-suite result is not sandbox-degraded.

### Platform coverage

| Platform | Status |
|---|---|
| macOS 26.5.2 arm64, Node v24.12.0 | executed, results above |
| Linux | **pending external runner** — no result; the CI shard added in `.github/workflows/ci.yml` runs it on `ubuntu-latest` |
| Windows | **pending external runner** — no result; the CI shard runs it on `windows-latest`, where the four Windows-only ACL cases execute rather than skip |

A Windows or Linux cell must not be inferred from the macOS run. In particular
the Windows-only ACL and DACL-replacement cases have **never executed** in this
verification, and the Windows filesystem semantics Phase 4C depends on (rename
over an open destination, sharing-violation retry, protected DACLs) are exactly
the ones a POSIX host cannot exercise.

## 10. CI shard

Added to `.github/workflows/ci.yml` as a fail-fast step on the existing
`ubuntu-latest` / `macos-latest` / `windows-latest` matrix:

```text
tests/trust-domain-separation.test.js
tests/trust-phase4c-cutover.test.js
tests/trust-revocation.test.js
tests/trust-migration.test.js
tests/trust-crash.test.js
tests/trust-project-binding.test.js
tests/restore-cli.test.js
tests/restore-store.test.js
tests/restore-confirmation.test.js
tests/restore-apply.test.js
tests/restore-recovery.test.js
tests/restore-receipt.test.js
tests/restore-boundary.test.js
tests/trust-api-boundary.test.js
tests/phase4c-conformance.test.js
```

The conformance gate asserts this list matches the workflow, so a property can
never be bound to evidence CI does not run.

## 11. Findings

### Finding 1 — `recoverRestoreTransactions` has no production caller (open)

`continuity/internal/restore/recovery.js` exports `recoverRestoreTransactions`,
and `tests/restore-recovery.test.js` proves it converges correctly from every
journal state. **Nothing in production ever calls it.** The only importers in the
repository are that test file.

Consequences:

- A crash during `restore apply` leaves an authenticated journal, a slot lock,
  and possibly a temporary file. The next `noosphere restore apply` does not
  recover them; it meets the held lock and fails closed.
- The Phase 4C claim "a fresh process can recover a crashed transaction" is true
  of the code and false of the shipped product.

This is not a boundary breach — an unreachable writer is trivially internal, and
the conformance gate passes because recovery's *behaviour* is proven. It is a
completeness gap in Task 8, and it is the reason the crash-recovery row above
carries a pointer rather than a bare `pass`. It should be resolved before
release, either by wiring recovery into the apply path (or a startup path) or by
narrowing the specification's recovery claim to an owner-invoked operation.

### Finding 2 — README operator documentation not updated (open)

Task 9 Step 4 of the implementation plan requires `noosphere-mcp/README.md` to
document the exact command list, exit codes 0–4, the seven-day retention period,
one-shot apply behaviour, the failed-apply restaging requirement, fixed
destinations, revoked-slot behaviour, and the owner-intervention recovery
outcome. That documentation has not been written. It is operator-facing, not a
security control, but the plan gates release on it.

## 12. Hostile review request

Release of SEC-05 Phase 4C is **blocked** pending an independent hostile review.
The reviewer should be given:

1. The Phase 4C specification and the implementation plan
   (`docs/superpowers/plans/2026-07-27-sec-05-phase-4c.md`).
2. The complete commit range `d2992c3..HEAD` (11 commits, Tasks 1–10).
3. This conformance matrix and the boundary inventory in §4–§5.
4. The unresolved cells: **Linux and Windows on every row**, and the Windows-only
   ACL cases that have never executed.
5. Findings 1 and 2 in §11.

Specifically asked of the reviewer — try to break, not confirm:

- **Cutover.** Find any path where format-1 state, a deleted manifest, a deleted
  binding, or a pre-4C format-2 record can still authorize bytes.
- **State machines.** Find a candidate, confirmation, or apply-journal transition
  that is reachable out of order, replayable, or rebindable across candidates,
  projects, or slots.
- **Final and recovery barriers.** Find a destination byte, a filesystem race, or
  a timing window that can select a branch after the owner confirmed — and check
  whether Finding 1 makes the recovery barrier unreachable in practice.
- **Cross-domain matrix.** Attempt a splice that preserves a MAC while exchanging
  candidate, confirmation, manifest, receipt, consumed-marker, journal, binding,
  identity, slot, generation, or transaction fields across the twelve domains.
- **Tri-platform filesystem behaviour.** On Windows especially: rename over an
  open destination, sharing violations, protected DACLs, reparse points, and
  8.3 short names against the fixed destination and the deterministic temporary
  path.
- **Alternate writer surfaces.** Find any way — export map, deep import, MCP
  tool, hook, lifecycle service, adapter, relayer, environment variable, config
  key, or CLI flag — to reach a mutation primitive without the interactive owner
  ceremony. Mutations A–G in §6 show what the current gate catches; find one it
  does not.
