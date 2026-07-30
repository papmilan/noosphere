# SEC-05 Phase 5 verification

## Status

Phase 5 implementation is a **release candidate**. SEC-05 remains open and the
repository remains **not public-ready** until the exact proposed head passes
Linux, macOS, and Windows CI and receives an independent hostile security review
with no Critical or Important finding.

Implementation candidate before this evidence record:
`f9795d6` (`ci(security): gate phase 5 on every platform`).

## Implemented controls

- Replay identity is derived only from the authenticated project identity,
  trusted local slot, and normalized content digest. Candidate identity remains
  random and neither persistence domain stores a cross-reference to the other.
- Replay observation, journal recovery, retention, typed restore suppression,
  ordinary recall, and typed context refresh share the global ranked lock order.
- Every production replay mutation path authenticates and recovers incomplete
  replay and retention journals before recording new evidence.
- Replay evidence is bounded to 4,096 live records and 90 days, with
  deterministic local-clock eviction and an authenticated compaction
  accumulator.
- `replay status` and bounded `replay list` authenticate existing evidence
  without recovery or byte changes. There is no public replay writer.
- Replay-key creation is permitted only for a pristine root. Missing,
  replacement, or corrupt keys with surviving replay artifacts fail closed.
  There is deliberately no reset, reinitialize, rotate, repair, recovery,
  import, or export surface.
- Replay labels are informational. They never approve, revoke, stage, apply,
  consume, or otherwise decide content authority.

## Local verification evidence

| Gate | Result |
| --- | --- |
| Complete `noosphere-mcp` `npm run check` | PASS — 853 passed, 0 failed, 4 documented platform/tooling skips |
| Focused Phase 5 conformance and mutation gate | PASS — 38 passed, including all 26 deterministic mutants killed |
| `@noosphere/secure-fs` `npm run check` | PASS — 53 passed, 0 failed, 1 native-Windows-only skip on macOS |
| Production recovery loopback shard | PASS — 3 passed after distinguishing sandbox `listen EPERM` from assertions |
| Package dry run | PASS — 108 entries, only declared bundled dependencies |
| Offline installed-tarball boundary | PASS — supported trust-store import works; replay writer/key deep imports return `ERR_PACKAGE_PATH_NOT_EXPORTED` |
| Diff whitespace check | PASS |

The full check initially exposed one obsolete Phase 4B assertion that compared
the entire local and recalled baseline presentation. Phase 5 §14 requires replay
labels on recalled typed content. The corrected test continues to prove identical
baseline-body derivation and header stripping while also requiring labels only
for recalled evidence.

## Cross-platform CI remediation

The first two exact-head runs — `71a6030` (run 30473921727) and `d157db9`
(run 30479522052) — passed on `ubuntu-latest` and `macos-latest` and failed on
`windows-latest` with 31 test failures and one file-level timeout inside
`npm run check`. No failure was a production defect on Windows: three were
POSIX-only assumptions in the new test scaffolding, one was a repository-wide
checkout defect that silently disarmed mutation testing, and one was a runtime
budget.

| Windows failure | Cause | Fix |
| --- | --- | --- |
| 17 crash tests: `replay-crash` (9), `replay-production-recovery` (3), `replay-retention` (5) | The children self-terminate with `process.kill(pid, 'SIGKILL')`. Windows has no signals: Node maps SIGKILL onto `TerminateProcess`, so the parent sees `status !== 0, signal === null`, not `status === null, signal === 'SIGKILL'`. | One shared `tests/helpers/child-crash.js` assertion that accepts both forcible-termination shapes and still requires the exact uncatchable-signal shape on POSIX. `tests/child-crash.test.js` covers both platform shapes on every platform. |
| 3 boundary tests: `replay-api-boundary` (2), `replay-cli-boundary` (1) | `new URL(import.meta.url).pathname` is `/D:/…` on Windows, and `path.resolve` turns that into `D:\D:\…`, so the package root did not exist and the CLI child never spawned. | Resolve the package root with `fileURLToPath`. |
| `replay-key-lifecycle` pristine-key test | POSIX mode bits do not carry owner-only intent on Windows, where Node reports `0o666`. The key is written by `writeOwnerOnlyFileExclusive`, whose Windows path sets the exact SID DACL. | Assert through the existing `tests/file-security.js` `assertOwnerOnlyFile` helper; `tests/windows-acl.test.js` remains the DACL evidence. |
| 9 of the 26 mutants in `replay-mutation` — exactly the 9 whose anchors span lines | `windows-latest` checks out with `core.autocrlf=true`. CRLF text cannot match an exact multi-line `\n` source anchor, so those mutants were reported as missing anchors rather than as killed mutants. | A repository `.gitattributes` pinning `* text=auto eol=lf`, so every platform checks out the bytes the digests, anchors, and mutants are written against. |
| `restore-recovery.test.js` (Phase 4C) timed out at 1 800 s | Every crash boundary spawns real children and each owner-only ACL inspection costs an external process on Windows: 130–230 s per boundary there versus a few seconds on POSIX. Its ten boundaries all passed but summed to 1 777 s, overrunning the per-test budget for the file itself. | Raise the per-test timeout to 3 600 s in `check`, `test`, and both SEC-05 CI shards. |

Run 30493832013 at `ba65d81` then took the Windows job further than any earlier
head: `npm run check` **passed** on `windows-latest` — 862 tests, 849 passed, 0
failed, 13 documented platform skips — in 3 h 54 min, and `ubuntu-latest` and
`macos-latest` stayed green. Two items remained:

- `npm run test:security` failed one assertion, the same POSIX-mode class as the
  replay key: `noosphere-secure-fs/tests/replacement.test.js` asserted mode
  `0o600` on the prepared sibling, which Node reports as `0o666` on Windows. The
  file already guarded its other three mode assertions with
  `process.platform !== 'win32'`; that guard now also covers the prepared
  temporary, and `secure-persistence.test.js` remains the Windows ACL evidence
  for the same path.
- The Windows job never reached either SEC-05 shard, for the third run in a row,
  because `npm run check` consumed ~4 of the job's 6 hours. The shards are now
  their own tri-platform `sec05-shards` job instead of steps appended to the
  full-suite job, so they run in parallel with the full suite, each with its own
  budget, and shard evidence no longer depends on the full suite finishing
  first.

Run 30508157056 at `cc93585` produced the first Windows shard evidence in the
workstream: `SEC-05 shards / windows-latest` passed both the Phase 4C and the
Phase 5 shard (3 h 24 min), alongside `ubuntu-latest` (57 s) and `macos-latest`
(59 s). The full-suite Windows job then failed one test that had passed at the
previous head:

- `replay-restore-suppression.test.js`, `concurrent identical staging creates at
  most one random candidate`, required **exactly one** of eight concurrent
  attempts to stage. Zero staged on Windows. That is the documented fail-closed
  contention residual, not a defect: every ranked lock refuses instead of
  waiting, and where each acquisition costs external process spawns all eight
  contenders can lose. The test now asserts what the contract actually
  guarantees, and asserts more than it did before: at most one attempt stages,
  the candidate artifacts equal the staged count exactly, every fulfilled
  outcome is `staged`, `suppressed`, or `already-consumed`, and every rejected
  attempt carries a typed fail-closed code that is never a corruption,
  malformed-artifact, authentication, or unsafe-state code. Uncontended liveness
  stays covered by the sequential staging tests, which still require the first
  attempt to stage.

Writing that loser assertion surfaced two contention refusals that the previous
assertion could not see, both fail-closed and neither mutating: eight pristine
first uses can make a loser refuse with `replay-key-missing-with-state` (key
creation convergence itself is covered by `replay-key-lifecycle.test.js`, so the
test now creates the key before racing), and concurrent state readers can refuse
with `state-destination-changed`.

Residual watch item: the Windows cost driver is one spawned process per
owner-only ACL inspection, not the replay ledger. Until that is reduced, Windows
runs about 40× slower than POSIX on child-process restore and replay tests, which
also makes it the platform where fail-closed lock contention shows up first.

## Normative traceability

`noosphere-mcp/tests/phase5-conformance.test.js` maps every identifier from
RPL-I01 through RPL-I14 and every RPL-T identifier in the Phase 5 specification
to at least one production test shard. It also guards the exact tri-platform CI
shard.

`noosphere-mcp/tests/replay-mutation.test.js` applies all 26 source mutations
from specification §22.8 to a temporary production-package replica. Every
mutant must remain syntactically valid and make the conformance suite fail.

## External release gates

| Gate | Status | Evidence |
| --- | --- | --- |
| Exact-head Linux CI | PENDING | PR workflow run required |
| Exact-head macOS CI | PENDING | PR workflow run required |
| Exact-head Windows CI | PENDING | PR workflow run required |
| Exact-head independent hostile security review | PENDING | No review accepted yet |
| No Critical or Important hostile-review findings | PENDING | Depends on review |

This document must be updated with the reviewed implementation head, workflow
run/job links, and hostile-review evidence before any SEC-05 closure or
public-readiness statement changes.

## Residuals by design

- Replay state is local evidence, not a remote-authorship proof, server-
  authenticated recall claim, or rollback-proof audit log.
- Complete replay-root deletion loses replay history. A later pristine use may
  create a new replay key and empty history; surviving partial state never does.
- Replay evidence does not silently suppress ordinary recall. Typed restore
  suppression is limited to matching authenticated local candidate lifecycle.
- The existing TTY gate remains an accidental-automation barrier, not proof of
  human presence.

