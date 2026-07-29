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

