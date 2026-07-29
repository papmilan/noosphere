# SEC-05 Phase 4C — Conformance Verification Record

Status: **not released.** This record is a documentation-only successor to the
runtime remediation and test-shard commits. It must not embed a claim that it
already knows its own final commit: after this document is committed, live
`git rev-parse HEAD` is the review target.

## 1. Heads, range, and external state

| Field | Evidence |
|---|---|
| Runtime remediation | runtime remediation head `cbbef81` — `fix(restore): fail closed across recovery races` |
| Test-shard split | test-shard head `a8552d3` — `test(restore): split recovery CLI shard` |
| Documentation successor | this record; live `git rev-parse HEAD` is the review target |
| Phase 4C range through the runtime remediation | `d2992c3..cbbef81`: 26 commits on top of `origin/main` |
| Phase 4C range through the test-shard split | `d2992c3..a8552d3`: 27 commits on top of `origin/main` |
| Merge base | `d2992c3f1ac3fd10bbd0abb9e1192bdc7193a016` |
| Pull request | [PR #34](https://github.com/papmilan/noosphere/pull/34) remains **draft**; do not merge |
| Live CI evidence | [run 30405130395](https://github.com/papmilan/noosphere/actions/runs/30405130395), old head `324f658` |

The live run had 13 passing checks and one failing Windows MCP check. It is not
evidence for either `cbbef81`, `a8552d3`, or this documentation successor.

### Remediation commit inventory

The range contains the Phase 4C authority implementation plus seven original
recovery remediation findings. The latest implementation waypoints before the
documentation successor are:

| Commit | Scope |
|---|---|
| `3f23c7b` | test coverage for field-splicing and concurrent-transition gaps |
| `d6cc4ce` | three lock-policy hostile-review findings |
| `324f658` | four recovery-semantics hostile-review findings |
| `cbbef81` | two follow-up race/crash-window findings; fail-closed recovery |
| `a8552d3` | test-only Windows recovery shard split |

## 2. Current operator and recovery contract

Trust mutations and restore staging require both TTY streams before operation
state is read or mutated. `restore apply` first runs recovery, then checks both
TTY streams; an exit 4 can therefore follow recovery reads or mutations, but
the refused request creates no new apply transaction.

Recovery may converge only authenticated apply-journal transactions, or the
narrow pre-journal window with an authenticated spent confirmation and matching
`apply-in-progress` candidate. The latter requires no slot lock and a final
re-enumeration that still finds no apply journal. Destination bytes do not select
a recovery path by themselves.

Every present slot lock requires owner intervention, even when its PID is gone.
Recovery never deletes a slot lock. An owner may remove one only after
independently confirming that no transaction is live, then rerun recovery.

A `prepared` journal never proves a rename. Only an exact authenticated
temporary may be discarded; an unexpected destination requires owner
intervention. Before any recovery mutation, the complete final barrier is
repeated while the recovery process holds the slot lock.

These statements are mechanically checked by
`tests/operator-docs.test.js`, `tests/restore-recovery.test.js`,
`tests/restore-recovery-cli-hostile-review.test.js`, and
`tests/phase4c-conformance.test.js`.

## 3. Local evidence carried forward

The following exact outputs are carried forward from the runtime remediation and
shard reports; they prove the named commits, not this documentation successor:

| Verification | Result |
|---|---|
| Runtime focused plus supplemental recovery suites | **119/119** passing |
| Split recovery CLI files | **27/27** passing |
| Operator docs + boundary + conformance | **63/63** passing |

The exact Phase 4C shard passed on macOS before these commits. The controller
must rerun it after this documentation task, because the shard now includes the
documentation contract and this record is a new head.

The split retains the existing 1,800-second test timeout and distributes all 27
recovery CLI cases across four files with 5/8/6/8 cases. It changes test layout,
not recovery runtime behaviour.

## 4. Windows CI status — unresolved

Run `30405130395` at old head `324f658` did not report an assertion failure in
the Windows MCP recovery tests. 12 slow recovery CLI cases passed at
118–173 seconds each. The then-monolithic recovery test file subsequently hit
its 1,800-second wrapper timeout before later cases executed.

`a8552d3` divides the same 27 cases into the four 5/8/6/8 files with the
unchanged timeout. The Windows fix is pending a new exact-head runner and must
not be marked pass yet. The failure is a harness-duration result, not proof that
the unexecuted cases passed or failed.

## 5. Findings closed by present implementation and tests

The following seven original recovery findings are closed only by the cited
implementation and named regression evidence; none is closed by an inference
from destination bytes or by an old CI run.

| Finding | Precise closure evidence |
|---|---|
| R1 — product reachability | `continuity/index.js` calls `recoverRestoreTransactions` before a new apply; `restore-boundary.test.js` proves the production call order and that recover cannot start a new apply transaction. |
| R2 — operator ordering claim | `noosphere-mcp/README.md` and `operator-docs.test.js` state and verify the pre-read two-TTY rule and the recovery-before-TTY apply exception. |
| R3 — lock policy | `recovery.js` treats every present slot lock as owner intervention; `leaves an abandoned lock byte-identical until the owner clears it`, `refuses a lock held by a live process without modifying it`, and lock-policy CLI cases prove the fail-closed policy. |
| R4 — rename/journal ordering | `restore-recovery-cli-hostile-review.test.js` proves a committed rename that precedes its journal event converges without a second replacement. |
| R5 — pre-journal stranded candidate | `releaseStrandedCandidate` authenticates the spent confirmation, requires no lock, rechecks journals, and is covered by `releases a candidate stranded mid-apply with no journal`. |
| R6 — stale pre-lock observations | `recoverOne` rereads the journal and repeats `assertCompleteChain` under the held lock; `repeats the manifest barrier under the recovery lock` proves it. |
| R7 — early journal semantics | `prepared` takes only its authenticated pre-state path and can discard only an exact temporary; `never infers a destination replacement from a prepared journal` proves it. |

Two follow-up review findings are likewise closed by `cbbef81` and their
regressions:

| Finding | Precise closure evidence |
|---|---|
| F1 — candidate namespace changes during recovery | The repeated under-lock `assertCompleteChain` validates candidate, receipt, and consumed-marker namespaces before mutation; `refuses a conflicting candidate namespace` proves the refusal. |
| F2 — exact temporary after a `prepared` crash | The early-state path authenticates and removes only the deterministic temporary; `discards an exact temporary left while the journal is still prepared` proves the cleanup. |

The conformance gate binds recovery, recovery reachability, lock policy, and
operator documentation to these implementation symbols and evidence names.

## 6. Release gate

Release remains blocked on a new exact-head tri-platform CI run and approving
final hostile review. The controller must run the Phase 4C shard at the live
post-documentation head, inspect Windows completion after the 5/8/6/8 split,
and retain the draft state until those results and an independent review are
recorded.

## 7. Hostile-review request

Review the current implementation range `d2992c3..a8552d3` plus this
documentation-only successor at its live `git rev-parse HEAD`. Evaluate the
approved fail-closed policy: both TTY streams before trust/stage state access;
recovery before the apply TTY refusal; no new transaction for that refusal;
authenticated journal or narrowly authenticated pre-journal recovery only; no
destination-byte-only branch; owner intervention for every present slot lock;
and the complete barrier repeated under lock before a mutation. Treat an
uncompleted exact-head Windows runner as unresolved, not as a successful result.
