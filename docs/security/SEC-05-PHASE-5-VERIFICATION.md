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

Residual watch item: `npm run check` alone took ~3.3 h on `windows-latest`, and
the Phase 4C and Phase 5 shards re-run its heaviest child-process files. Total
`noosphere-mcp / windows-latest` job time is the next gate to observe against
GitHub's 6 h job ceiling; the cost driver is one spawned process per Windows
owner-only ACL inspection, not the replay ledger.

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

