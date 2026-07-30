# SEC-05 Phase 5 verification

## Status

Phase 5 is **complete and SEC-05 is closed**. The final head
`d6dc0b6b2bbe5cd2d777fcd589769d3cb79e3857` satisfied both closure gates:

- **Tri-platform exact-head CI**:
  [run 30526063300](https://github.com/papmilan/noosphere/actions/runs/30526063300)
  passed on Linux, macOS, and Windows, including the dedicated `sec05-shards`
  job (Phase 4C and Phase 5 suites) on all three platforms.
- **Independent hostile security review** at the same exact head reported
  **no Critical, Important, or Minor finding**
  ([review comment](https://github.com/papmilan/noosphere/pull/35#issuecomment-5128585599)).
  An earlier clean hostile re-review at intermediate head `d157db9` covered the
  crash-lock and serialized-refresh remediation; the final review verified the
  delta since then, including the persistent Windows ACL helper's trust
  boundary.

Merged in [PR #35](https://github.com/papmilan/noosphere/pull/35), merge commit
`c54189b6882c481d91ab71ef2af5a63378890223`.

One hardening observation from the final review is recorded as a non-finding:
the manual Windows ACL profiler workflow interpolates its `workflow_dispatch`
file input into PowerShell. Dispatch requires repository write-level trust and
the workflow exposes no secrets, so this creates no new privilege boundary;
allowlist or array-based argument construction remains a robustness follow-up.

Implementation candidate at the start of this evidence record:
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
| `restore-recovery.test.js` (Phase 4C) timed out at 1 800 s | Every crash boundary spawns real children and each owner-only ACL inspection costs an external process on Windows: 130–230 s per boundary there versus a few seconds on POSIX. Its ten boundaries all passed but summed to 1 777 s, overrunning the per-test budget for the file itself. | Raised the per-test timeout to 3 600 s as a stopgap, then removed the cost itself — see "Windows ACL cost" below — and returned the budget to 1 800 s. |

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

## Windows ACL cost

The residual watch item above — one spawned process per owner-only ACL
operation — was measured rather than estimated, and then removed.

Run 30520811266 runs `restore-recovery.test.js` twice on `windows-latest`, once
through the persistent ACL helper host and once with `NOOSPHERE_ACL_NO_HOST=1`,
which forces the previous process-per-call behaviour. Same commit, same runner
class, same 7 930 ACL operations:

| | process per call | persistent host |
| --- | --- | --- |
| Whole file (19 tests) | 3 026.9 s | **58.6 s** |
| Ten crash boundaries | 1 838.5 s (144–211 s each) | **36.2 s** (2.7–4.2 s each) |
| Mean per ACL operation | 315.7 ms | **4.0 ms** |
| Share of wall clock in ACL operations | 82.7 % | 54.4 % |

The same job measures the floor those numbers are explained by: **350–357 ms**
for one bare `powershell.exe -NoProfile -Command exit` on that runner. The old
mean per operation was 315.7 ms against a 350 ms floor, so essentially the
entire cost was starting the process, not applying or verifying the DACL. Paying
that start once per Node process instead of once per file operation is the whole
of the change; what is applied and verified is unchanged, and
`tests/windows-acl.test.js` now cross-checks the two transports by writing
through the host and verifying the exact SID DACL through a one-shot invocation.

`NOOSPHERE_ACL_PROFILE=1` prints per-action counts and cost at process exit, and
`.github/workflows/windows-acl-profile.yml` re-runs this comparison; push a
branch ending in `/acl-profile` to trigger it.

Not measured: the full `npm run check` on Windows, which took ~3 h 54 min at
`ba65d81`. Reads are 7 276 of the 7 930 operations in the file above, so a large
drop is expected there too, but this workstream has not yet produced that number.

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

