# SEC-05 Phase 5 Replay Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` task-by-task and `test-driven-development` for every behavior change. Do not use parallel workers unless the owner explicitly delegates work.

**Goal:** Add persistent, bounded replay detection that labels ordinary recall, suppresses duplicate typed restore staging, recovers interrupted replay transactions through real production paths, and never influences authority.

**Architecture:** Build a replay-only owner-local store under `replay-v1`, authenticated by its own key and domains. A production replay-operation boundary performs recovery before observation. Typed staging uses an opaque ranked lock scope across replay observation and a restore-domain candidate-index match/create adapter. Replay identity is deterministic; candidate identity remains random; neither store persists a cross-reference.

**Tech stack:** Node.js ESM, `node:crypto`, `node:fs/promises`, `node:test`, existing canonical JSON and secure-filesystem primitives, HMAC-SHA-256.

**Normative design:** [`docs/security/SEC-05-PHASE-5-SPEC.md`](../../security/SEC-05-PHASE-5-SPEC.md), amended at `ade888a`.

## Global constraints

- Replay state never enters authority selection, approval, revocation, restore apply, or recovery.
- Every production replay mutation path recovers authenticated incomplete replay journals before observing new content.
- `replay status` and `replay list` are byte-for-byte read-only and never recover.
- Candidate IDs remain independent random 52-character Phase 4C IDs.
- No replay artifact contains candidate identity/path/reference; no candidate artifact contains replay identity/path/reference.
- The only live cross-domain matching input is `(projectIdentityDigest, localSlot, candidatePayloadHash)`.
- Lock ranks are 10 catalog, 20 replay project, 30 replay identity, 40 restore candidate index, 50 candidate state, 60 authority/apply.
- Lower-rank acquisition while holding a higher rank fails before filesystem mutation; same-rank keys are lexical.
- Replay/candidate locks are released before any rank-60 authority or apply operation.
- Replay-key reinitialization, rotation, reset, repair, import, and recovery are intentionally absent.
- First-use key creation is legal only for a pristine replay root. Missing/replaced key plus surviving state fails replay closed.
- Use `apply_patch` for edits, run each new test in RED before production changes, and commit only green, reviewable slices.

---

### Task 1: Canonical replay identity and strict identity separation

**Files:**
- Create: `noosphere-mcp/continuity/internal/replay/identity.js`
- Create: `noosphere-mcp/tests/replay-identity.test.js`

**Interfaces:**
- `deriveReplayIdentity({ projectIdentityDigest, slot, content })`
- Returns exactly `{ normalizedBytes, payloadDigest, replayIdentity }`; it accepts no candidate or remote metadata.
- Slots are exactly `master-prompt`, `instructions`, `baseline`, `followups`, and `ordinary`.

- [x] Write tests that independently calculate the §6 golden vectors with `createHash`, `canonicalize`, and `normalizeUntrusted`.
- [x] Assert equal normalized content is stable across processes and metadata changes, while project/slot/content changes alter the identity.
- [x] Assert unknown fields, candidate-shaped fields, invalid project digests, invalid slots, non-string content, and inherited properties are rejected.
- [x] Run `cd noosphere-mcp && node --test --test-concurrency=1 tests/replay-identity.test.js`; verify an assertion failure because the production module is absent.
- [x] Implement only the pure identity function using existing canonicalization and normalization.
- [x] Re-run the focused test and `node --check continuity/internal/replay/identity.js`.
- [x] Commit: `feat(security): derive isolated replay identities`.

### Task 2: Replay schemas, domains, and deliberate key lifecycle

**Files:**
- Create: `noosphere-mcp/continuity/internal/replay/constants.js`
- Create: `noosphere-mcp/continuity/internal/replay/schema.js`
- Create: `noosphere-mcp/continuity/internal/replay/key.js`
- Modify: `noosphere-mcp/continuity/internal/authenticated-records.js`
- Create: `noosphere-mcp/tests/replay-schema.test.js`
- Create: `noosphere-mcp/tests/replay-key-lifecycle.test.js`

- [x] RED-test exact fields, bounds, enums, canonical JSON, unknown fields, payload absence, and candidate/replay cross-reference rejection.
- [x] RED-test ordered replay-domain substitution against every authority and restore domain.
- [x] RED-test pristine exclusive key creation, concurrent first use, unsafe paths, surviving-state key loss/replacement, and complete-root deletion/new-install behavior.
- [x] Assert no exported reset/reinitialize/rotate/repair/import/recovery function exists.
- [x] Add replay-only domains for catalog, manifest, record, journal, checkpoint, and lock; do not invent a persisted key-metadata artifact absent from the normative RFC.
- [x] Implement strict schema validators and replay-root state inventory before key creation.
- [x] Re-run focused tests plus `tests/trust-domain-separation.test.js`.
- [x] Commit: `feat(security): establish replay key and schema domains`.

### Task 3: Ranked lock hierarchy and restore candidate-index lock

**Files:**
- Create: `noosphere-mcp/continuity/internal/replay/lock-ranks.js`
- Create: `noosphere-mcp/continuity/internal/replay/lock.js`
- Create: `noosphere-mcp/continuity/internal/restore/candidate-index-lock.js`
- Create: `noosphere-mcp/tests/replay-lock-hierarchy.test.js`

**Interfaces:**
- `createRankedLockScope()` returns an opaque scope with current rank/key.
- Replay lock acquisition accepts only ranks 10/20/30.
- Restore candidate-index acquisition accepts only rank 40 and the trusted tuple; it never accepts replay identity.

- [x] RED-test ascending ranks, descending refusal before mutation, lexical same-rank order, reverse release, malformed/present lock refusal, and no stale deletion.
- [x] RED-test that candidate-index lock files bind project, slot, and payload hash in a distinct restore MAC domain.
- [x] Implement common rank assertions and domain-specific lock adapters using existing owner-only/no-follow primitives.
- [x] Ensure rank 60 cannot begin while the opaque scope holds ranks 20–50.
- [x] Re-run focused lock, restore candidate, and authority lock tests.
- [x] Commit: `feat(security): enforce replay restore lock hierarchy`.

### Task 4: Replay store and monotonic observation state

**Files:**
- Create: `noosphere-mcp/continuity/internal/replay/store.js`
- Create: `noosphere-mcp/continuity/internal/replay/classify.js`
- Create: `noosphere-mcp/continuity/internal/replay/observe.js`
- Create: `noosphere-mcp/tests/replay-store.test.js`
- Create: `noosphere-mcp/tests/replay-state.test.js`

- [x] RED-test `NeverSeen → SeenOnce → Replayed`, exact counts, immutable first event, monotonic generations, metadata exclusion, and fail-closed corrupt state.
- [x] RED-test that deleting/corrupting replay files leaves authoritative and untrusted slot decisions byte-for-byte unchanged.
- [x] Implement catalog/project manifest/record authenticated reads and bounded atomic writes.
- [x] Implement pure classification mapping: first `NEW`, second ordinary `SEEN`, later `REPLAYED`, typed duplicates `SUPPRESSED` only after candidate matching.
- [x] Re-run focused replay and Phase 4C authority tests.
- [x] Commit: `feat(security): persist monotonic replay observations`.

### Task 5: Authenticated journal and production-reachable recovery

**Files:**
- Create: `noosphere-mcp/continuity/internal/replay/journal.js`
- Create: `noosphere-mcp/continuity/internal/replay/operation.js`
- Create: `noosphere-mcp/tests/replay-crash.test.js`

**Interfaces:**
- `withReplayOperation(input, callback)` acquires the ranked scope, recovers, then permits observation.
- Direct recovery remains internal to `journal.js` and is not package-exported.

- [x] RED-test process death at prepared, record-committed, manifest-committed, and complete boundaries.
- [x] RED-test exact-before/exact-after recovery, idempotence, no double count, immutable first-seen, and third-state refusal.
- [x] Implement authenticated append-only journal transitions and exact-state recovery.
- [x] Require every replay observation primitive to receive a scope created by `withReplayOperation`; keep inspection paths outside it.
- [x] Re-run crash tests twice in fresh processes.
- [x] Commit: `feat(security): recover replay journals on production paths`.

### Task 6: Deterministic bounded retention

**Files:**
- Create: `noosphere-mcp/continuity/internal/replay/retention.js`
- Create: `noosphere-mcp/tests/replay-retention.test.js`
- Modify: `noosphere-mcp/continuity/internal/replay/operation.js`

- [ ] RED-test the 4,096 live-record cap, 90-day age cap, lexical tie-break, 7-day/1,024 completed-journal bounds, incomplete-journal preservation, and exact compaction accumulator.
- [ ] RED-test crash/recovery at every retention boundary and prove remote timestamps/rankings do not influence eviction.
- [ ] Implement deterministic retention under rank 20 with authenticated checkpoint and journal.
- [ ] Re-run retention, crash, and authority-independence tests.
- [ ] Commit: `feat(security): bound replay evidence deterministically`.

### Task 7: Typed restore duplicate suppression with zero identity cross-reference

**Files:**
- Modify: `noosphere-mcp/continuity/internal/restore/candidate-store.js`
- Modify: `noosphere-mcp/continuity/internal/restore/cli.js`
- Create: `noosphere-mcp/continuity/internal/replay/restore-stage.js`
- Create: `noosphere-mcp/tests/replay-restore-suppression.test.js`
- Create: `noosphere-mcp/tests/replay-identity-separation.test.js`

- [ ] RED-test active, apply-in-progress, consumed, conflicting, malformed, and absent candidate outcomes.
- [ ] RED-test N concurrent identical staging calls create one random candidate, while different slots/content create independent random candidates.
- [ ] Snapshot/scan every replay and candidate artifact and assert neither domain persists the other identity/path/reference.
- [ ] Add authenticated candidate lookup by trusted tuple under rank 40 without changing candidate envelopes/state.
- [ ] Add live orchestration that retains ranks 20/30, acquires rank 40, observes replay, then matches/creates and releases in reverse.
- [ ] Ensure replay recovery never creates/selects/consumes a candidate and retry can fill only a missing candidate.
- [ ] Re-run all restore stage/apply/recovery tests.
- [ ] Commit: `feat(security): suppress duplicate restore candidates`.

### Task 8: Structured ordinary recall and typed context labels

**Files:**
- Modify: `noosphere-mcp/continuity/index.js`
- Modify: `noosphere-relayer/index.js` only if an existing structured client helper must be exposed internally; do not add a replay writer.
- Create: `noosphere-mcp/tests/replay-ordinary-recall.test.js`
- Create: `noosphere-mcp/tests/replay-context-refresh.test.js`
- Create: `noosphere-mcp/tests/replay-production-recovery.test.js`

- [ ] RED-test structured-response validation, original ordering, duplicate visibility, quote rendering, replay labels, and `CURRENT`/`STALE`/`TIME_UNVERIFIED`.
- [ ] RED-test replay-unavailable behavior: ordinary content remains visible and authority remains unchanged.
- [ ] Replace prompt-text parsing with structured recall ingestion where replay labels are produced.
- [ ] Route ordinary and typed context observations through the production operation boundary.
- [ ] Build child-process fixtures that strand authenticated journals, then enter
  through real `restore stage`, structured ordinary recall, and typed context
  refresh; prove recovery precedes observation without directly importing the
  recovery helper.
- [ ] Re-run recall/context, relayer-authority, and injection tests.
- [ ] Commit: `feat(security): label replayed recalled memory`.

### Task 9: Read-only inspection and mutation-surface lockdown

**Files:**
- Create: `noosphere-mcp/continuity/internal/replay/reader.js`
- Create: `noosphere-mcp/continuity/internal/replay/cli.js`
- Modify: `noosphere-mcp/continuity/index.js`
- Modify: `noosphere-mcp/package.json`
- Create: `noosphere-mcp/tests/replay-cli-boundary.test.js`
- Create: `noosphere-mcp/tests/replay-api-boundary.test.js`
- Create: `noosphere-mcp/tests/replay-domain-separation.test.js`

- [ ] RED-test exact `replay status`/`list` grammar and bounded projections.
- [ ] Hash the replay root before/after readers, including incomplete journals, and require byte-for-byte equality.
- [ ] RED-test absence of add/clear/reset/reinitialize/rotate/repair/recover/import/export across CLI, package, packed npm, MCP, HTTP, hooks, lifecycle, adapters, and relayer.
- [ ] Implement readers that authenticate and report health without entering `withReplayOperation`.
- [ ] Update syntax-check inputs without exposing writer exports.
- [ ] Run package dry-run and installed-package deep-import checks.
- [ ] Commit: `feat(security): expose bounded replay inspection`.

### Task 10: Mutation harness, conformance, docs, and exact-head gates

**Files:**
- Create: `noosphere-mcp/tests/replay-mutation.test.js`
- Create: `noosphere-mcp/tests/phase5-conformance.test.js`
- Create: `docs/security/SEC-05-PHASE-5-VERIFICATION.md`
- Modify: `docs/project-memory/THREAT_MODEL.md`
- Modify: `noosphere-relayer/MEMORY_SECURITY.md`
- Modify: `SECURITY.md`
- Modify: `CHANGELOG.md`
- Modify: `noosphere-relayer/SECURITY-FOLLOWUPS.md`

- [ ] Implement all 26 deterministic mutations in §22.8 and prove each mutation makes the relevant test fail.
- [ ] Add a conformance map for every RPL-I and RPL-T identifier.
- [ ] Run focused replay tests, full `npm run check`, secure-fs tests, package/CLI/API boundaries, and clean-tree checks.
- [ ] Run exact-head Linux, macOS, and Windows CI; Windows is mandatory for Phase 5 even though the owner deferred the Phase 4C Windows wait.
- [ ] Obtain exact-head hostile security review with no Critical or Important finding.
- [ ] Pin the verification record to the reviewed exact head and only then update SEC-05 closure/public-readiness documentation.
- [ ] Commit documentation only after its claimed evidence exists.

## Execution checkpoints

After Tasks 1–3, review identity and lock boundaries before storage mutations expand.
After Tasks 4–6, review crash/retention invariants and authority independence.
After Tasks 7–9, review all mutation surfaces and production reachability.
Task 10 is the release gate; never merge or mark a pull request ready automatically.
