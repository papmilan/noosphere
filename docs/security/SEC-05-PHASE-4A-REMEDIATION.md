# SEC-05 Phase 4A — Review Response and Remediation Plan

Reviewed commit: `6b7c8287fa5b54ce09dded1e220b9e25eddee2e7`
Branch: `codex/sec-05-phase-4a`  ·  Base: `ad7b88b`  ·  Review decision: REQUEST CHANGES
No code modified. No amend/rebase/push/merge. Phase 4B/4C not started.

> **Status: HISTORICAL — the plan below was carried out and SEC-05 is closed.**
> Preserved as authored. Read "Phase 4B/4C not started", "no code modified", and
> every present-tense claim about the state of the tree as true on the date of
> review, not now.
>
> The R1→R2→R3 series this document specifies shipped as #29, #30, and #31;
> Phase 4B as #32 and #33, Phase 4C as #34, Phase 5 as #35. The reviewed commit
> `6b7c828` and its branch `codex/sec-05-phase-4a` no longer exist — the branch
> was deleted once every file it added was superseded by the r1/r2/r3 versions
> in `main`.
>
> This is the record of *why* Phase 4A was rejected and rebuilt: authority logic
> stranded in a package-excluded test harness (B1), crash tests that never
> crashed (B2), and the bounded structural, durability, and identity gaps
> (M1–M5). The finding adjudication in §2 and the architecture in §6–§10 are the
> reasoning the shipped implementation follows.

---

## 1. Exact-head confirmation

- Branch `codex/sec-05-phase-4a` exists; its tip is exactly `6b7c8287fa5b54ce09dded1e220b9e25eddee2e7`. ✅
- `git cat-file -t 6b7c8287…` = commit; `ad7b88b` = commit. ✅ Base matches.
- Diff `ad7b88b..6b7c8287` = 9 files, +535/−5:
  `noosphere-mcp/continuity/trust-store-internal.js`, `noosphere-mcp/package.json`,
  `noosphere-mcp/tests/helpers/trust-test-harness.js` (+229), 4 new test files,
  `noosphere-secure-fs/index.js` (+46), `noosphere-secure-fs/tests/secure-persistence.test.js`.
- Working tree is **not** pristine: `.noosphere/state.json` (M) and `.worktrees/` (untracked) are present, but both are on the current `codex/sec-05-phase-3-sink-unification` checkout and touch **none** of the reviewed paths. They do not affect any finding. Adjudication was performed by reading blob contents at `6b7c8287` via `git show`, not the working tree, so it is unaffected.
- Focused suite not re-run in this session (would require a phase-4a checkout; tree is dirty on another branch). Adjudication is source-evidence based. Codex's journal records `96/96` focused SEC-05 + secure-fs pass at this head.

No exact-HEAD mismatch. Proceeding.

---

## 2. Finding adjudication table

| # | Finding | Verdict | Post-adjudication severity |
|---|---------|---------|-----|
| B1 | Format-2 logic lives only in test harness (package-excluded) | **ACCEPTED — ARCHITECTURAL DEFECT** | Blocker |
| B2 | Crash tests run `finally`, release locks, never test real crash/stale-lock | **ACCEPTED — TEST/EVIDENCE GAP** | Blocker |
| M1 | Audit chain permits invalid early termination | **PARTIALLY ACCEPTED** (MAC-bounded; genesis not pinned to gen 1; predecessor linkage incomplete) | Major |
| M2 | Canonical schemas incomplete | **PARTIALLY ACCEPTED** (dup-key + unknown-field already caught; missing fatal-UTF8/BOM/RFC3339/enum/journal-transition) | Major |
| M3 | Lock: loose token, no authenticated parser, no stale policy | **PARTIALLY ACCEPTED** (token regex loose = defect; metadata MAC unverified on inspect; fail-closed policy acceptable but implicit/untested) | Major |
| M4 | Same-realpath projects collide | **PARTIALLY ACCEPTED — ARCHITECTURAL** (deliberate Option A; needs explicit claim + negative test, or Option B) | Major |
| M5 | No parent-dir fsync after POSIX rename; Windows durability unproven | **ACCEPTED — DURABILITY DEFECT** (availability only; never mints authority) | Major |
| H1 | Windows only via injected adapter | ACCEPTED — TEST/EVIDENCE GAP | Hardening |
| H2 | Junction/reparse not proven natively | ACCEPTED — TEST/EVIDENCE GAP | Hardening |
| H3 | Exact record-size boundary untested | PARTIALLY ACCEPTED (`+1` tested; exact-max + multibyte missing) | Hardening |
| H4 | Inverse M-2 regression missing | ACCEPTED — TEST/EVIDENCE GAP | Hardening |
| H5 | Package-root compatibility unverified | PARTIALLY ACCEPTED (deep-import deny + pack-exclusion tested; ESM/CJS/root import untested) | Hardening |

No finding is rejected. Two challenges are recorded in §5 (scope corrections, not rejections).

---

## 3. Accepted Blockers

### B1 — Security-critical logic is test-only (ARCHITECTURAL)
Evidence: every format-2 primitive — `createProjectBinding`, `readProjectBinding`, `readImmutableRecord`, `readManifest`, `readAudit`, `acquireLock`, `verifyAuditChain`, `isFormat2Authoritative`, `commitTestTransaction`, `recover`, `writeJournal` — is defined inside `tests/helpers/trust-test-harness.js`. `package.json#files` is `["CSP.md","continuity/","hooks/","lifecycle/","mcp-server/"]`; `tests/` is excluded and `trust-api-boundary.test.js` asserts the harness is absent from `npm pack`. Consequence: Phase 4B must copy or re-derive authority-critical logic, and the reviewed tests do not exercise the code 4B will ship. This is the blocker that forces the corrective series (§18, R1).
- Affects: **integrity + reviewability**.
- Correction: extract the primitives into production-internal modules under `continuity/internal/`; tests import those exact modules.
- Negative test: `trust-api-boundary.test.js` extended to prove the new modules are still non-exported and non-deep-importable (§7).

### B2 — Crash tests do not simulate process death (TEST/EVIDENCE GAP)
Evidence: `commitTestTransaction` injects `throw Object.assign(new Error('simulated crash'), {code:'simulated-crash'})` at each boundary, but the whole body is wrapped in `try { … } finally { await lock.release().catch(()=>undefined); }`. Every simulated crash therefore runs `finally` and releases the lock. So: (a) `recover()`'s `trust-lock-live` branch is never reached by a "crash"; (b) no test ever observes a stale lock left by a dead process; (c) no test proves an orphan record/audit/journal cannot confer authority after an *abrupt* termination that skips cleanup. The `does not reclaim a live lock` test manufactures the lock via `acquireLock`, not via a crash. The recovery/atomicity claims are therefore unproven under real crash semantics.
- Affects: **availability + integrity (recovery correctness)**.
- Correction: child-process crash harness with SIGKILL / forceful Windows termination and **no** `finally` cleanup in the child (§9).
- Negative tests: enumerated per boundary in §9.

---

## 4. Accepted Majors

### M1 — Audit-chain early termination (structural completeness)
`verifyAuditChain` returns `true` the moment `event.previousAuditEventId === null`, without asserting that at genesis `expectedGeneration === 1`, nor that `previousGeneration === 0`, `previousRecordId === null`, `previousAuditEventHash === null`. It also never cross-checks `event.previousGeneration === expectedGeneration - 1` or that the predecessor record id matches `event.previousRecordId`. The chain is MAC-authenticated (each event's `generation`, `previousAuditEventId`, `previousAuditEventHash` are inside the MAC), and iteration is bounded by the monotonically decreasing `expectedGeneration` (no DoS), so a *forged* truncation requires key compromise. But this is the reusable validator Phase 4B calls; its structural incompleteness must be closed. Affects **integrity + reviewability**. Correction + tests in §6.

### M2 — Canonical schema completeness
`readCanonical` does `JSON.parse(text)` then rejects unless `text === canonicalize(parsed)`. That byte-equality already rejects duplicate keys (JSON.parse keeps last; canonical emits one → mismatch) and non-canonical ordering/whitespace; unknown extra fields on authenticated records are rejected by MAC (MAC covers all non-`mac` fields). Genuinely missing: fatal UTF-8 decode (`toString('utf8')` is lenient), explicit BOM rejection, RFC 3339 UTC validation (`approvedAt`/`timestamp`/`startedAt` are only `typeof === 'string'`), enum-constrained `state`/`slot`/`eventType`, and a complete journal schema/transition validator. Affects **integrity**. Framework + exact schemas in §5/§7.

### M3 — Lock token + stale policy
`acquireOwnerOnlyLock` validates the token with `/^[0-9a-f-]{36}$/i` — 36 hyphens or any hex/hyphen mix passes; it is **not** a UUID check. The harness supplies `crypto.randomUUID()`, so production paths are fine today, but the reusable boundary is loose. Lock metadata is signed by the harness (`trust-lock` MAC) but secure-fs cannot verify it (no key), and `recover()` never authenticates the lock — it treats any present lock as `trust-lock-live` and refuses (fail-closed, which §8 endorses). Gaps: tighten token to strict RFC 4122 or fixed hex; authenticate lock metadata during recovery inspection; make the fail-closed stale policy explicit and tested. Affects **integrity + availability**. Design in §8.

### M4 — Project identity / same-realpath collision (ARCHITECTURAL)
`bindingPath(root) = …/bindings/${hash(realpathSync(root))}.json` — identity is keyed purely on canonical realpath, and the code comment states Phase 4A "deliberately permits one active identity per physical tree." Two distinct logical projects sharing one physical tree share authority. This is a conscious Option A. Note the mitigation already present: because the key is owner-side binding state, neither repository content nor environment variables can fork or select a second identity. Decision required (§10). Affects **authority**.

### M5 — Durability (parent-dir fsync)
`writePosixTemporary` fsyncs the file (`handle.sync()`), but `atomicOwnerOnlyWrite` performs `rename(tmp, file)` with **no** subsequent parent-directory fsync, and newly created parent dirs (`ensureContainedDir`→`mkdir`) are never fsynced. After power loss the rename (and directory entries) may not be durable → a committed manifest can vanish or revert. The Windows path calls the PowerShell helper `write` then checks size; `FlushFileBuffers`/durable-replace is unproven. Critically: a missing/partial manifest is **fail-closed** (recovery + `isFormat2Authoritative` reject it) — availability loss, never spurious authority. Affects **availability**. Decision in §11/§14/§15.

---

## 5. Findings challenged with evidence (scope corrections, not rejections)

1. **M2 "permissive JSON.parse / duplicate keys":** partially over-stated. Duplicate-key and unknown-field admission are **already** closed — the first by the canonical-reserialization byte comparison in `readCanonical`, the second by MAC coverage of all non-`mac` fields. Evidence: `if (text !== canonicalize(parsed)) throw 'record-non-canonical'`, and `hmac(key, type, fields)` over `{...record}` minus `mac`. The remediation therefore adds fatal-decode/BOM/timestamp/enum/journal-transition strictness, not duplicate-key handling. This narrows R1 scope.

2. **M3 "no safe stale/dead-lock recovery policy":** the *absence* of automatic reclamation is not itself a defect. §8 of the review mandates "prefer fail-closed owner intervention over unsafe automatic reclamation," and `recover()` already does exactly that. The real defects are the loose token regex and the unauthenticated lock inspection — not the fail-closed stance, which is retained by design.

Neither challenge removes work; both bound it.

---

## 6. Correct production-internal module architecture

Move every format-2 primitive out of the test harness into non-exported production-internal source. Proposed layout under `noosphere-mcp/continuity/internal/` (a directory with **no** entry in `package.json#exports`):

| Module | Responsibility |
|--------|----------------|
| `internal/strict-schema.js` | shared exact-schema parser (§5 framework): fatal UTF-8, BOM reject, size cap before decode, canonical-byte compare, typed field validators (uuid/hex/enum/rfc3339/safe-int), record-type/domain match |
| `internal/trust-format-v2.js` | format-2 constants, `canonicalize` re-export, MAC helpers (`hmac`, `validateMac`, `contentHash`), record read/write of immutable records |
| `internal/trust-manifest.js` | manifest schema, read + commit + CAS |
| `internal/trust-audit.js` | audit-event schema, event creation, **complete** chain validation (§6 algorithm) |
| `internal/trust-journal.js` | journal schema + state machine (§7) + recovery inspection |
| `internal/trust-project-binding.js` | binding schema, create/read, identity semantics (§10) |
| `internal/trust-transaction.js` | serialized transaction execution composing the above |
| `internal/trust-authority.js` | `isFormat2Authoritative` verification |

`continuity/` (the exported surface) is unchanged except that `trust-store.js` remains the only export. The harness becomes a thin test adapter that **imports** `internal/*` and exposes deterministic fixtures (clock injection, orphan/crash seeding) — it contains no security logic. This satisfies the re-review gate "tests exercise the same internal implementation future Phase 4B will call." No logic is duplicated between production and tests.

Note on `continuity/secure-fs.js`: it is already a re-export of `@noosphere/secure-fs`; the lock/token/durability corrections land in `noosphere-secure-fs/index.js` so relayer and MCP cannot drift.

---

## 7. Writer-boundary design

The boundary is against **supported application reachability and confused-deputy exposure**, not against a malicious local process reading installed files (the plan explicitly disclaims the latter — filesystem bytes on the host are always readable by a same-host attacker; only OS ACLs limit that, and those are SEC-03's job).

Layers:
1. **Package exports** — `package.json#exports` lists only `./trust-store` and `./package.json`. `internal/*` has no export entry, so `import 'noosphere-continuity/continuity/internal/trust-transaction.js'` fails `ERR_PACKAGE_PATH_NOT_EXPORTED`. (Already proven for `trust-store-internal.js` in `trust-api-boundary.test.js`.)
2. **No supported deep import** — the export map's presence disables *all* subpath access except the two listed; extend the boundary test to assert an `internal/*` deep import is rejected.
3. **Unreachable from CLI/MCP/adapters** — grep gate (extend the existing `continuity/*.js` scan) proving no shipped file under `mcp-server/`, `hooks/`, `lifecycle/`, or `continuity/` imports `internal/trust-*` writers. Read-only authority *verification* (`isFormat2Authoritative`) may later be wired; authority *writers* (`commitTestTransaction`) must not.
4. **Importable by trusted internal Phase 4B code** — `internal/*` is real source and ships in the package (`continuity/` is in `files`), so a future in-process trusted approval service can `import` it by relative path. It is reachable by co-located trusted code, not by package consumers.
5. **Testable without public export** — tests import via relative path (`../continuity/internal/…`), which needs no export map.

Distinctions held explicit: source-file presence (yes, ships) ≠ package exportability (no) ≠ supported API reachability (no) ≠ arbitrary same-host FS access (out of scope, SEC-03/OS ACL).

---

## 8. Strict schema framework (§5 required)

`internal/strict-schema.js` exposes `parseAuthenticated(raw, { type, domain, maxBytes, schema })`:

- **size cap before decode** — reject if `raw.length > maxBytes` before `toString`.
- **fatal UTF-8** — `new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw)`; a BOM or invalid sequence throws.
- **duplicate-key rejection** — `JSON.parse` with a reviver that throws on a key already seen in the same object (belt-and-suspenders alongside the canonical compare).
- **canonical reserialization** — `text === canonicalize(parsed)` (retained).
- **schema application** — required fields present; unknown fields rejected unless `schema.allowExtra`; per-field validators: `uuid` (strict RFC 4122 incl. version/variant), `hex64` (`/^[0-9a-f]{64}$/`), `enum(set)`, `rfc3339utc` (strict `YYYY-MM-DDTHH:MM:SS(.sss)Z`, parse-round-trip), `safeInt` (`Number.isSafeInteger`), `nonNegInt`, exact scalar type.
- **record-type/domain match** — `parsed.format === 2 && parsed.type === type`.

MAC verification stays a separate step layered on top (schema first, then `validateMac`), so malformed bytes never reach the constant-time compare.

Exact schemas (field → validator):

- **slot record**: `format:2`, `type:'slot-record'`, `recordId/projectIdentity/approvalEventId/auditEventId:uuid`, `previousRecordId:uuid|null`, `slot:enum{master-prompt,instructions,baseline}`, `generation:nonNegInt≥1`, `rawHash/contentHash/keyId:hex64`, `normAlgo:enum{NORM_ALGO}`, `normVersion:int===NORM_VERSION`, `sourceOrigin:string`, `approvedAt:rfc3339utc`, `mac:hex64`.
- **manifest**: `type:'manifest'`, `projectIdentity/currentRecordId/auditHeadId:uuid`, `currentRecordHash/auditHeadHash/keyId:hex64`, `slot:enum`, `currentGeneration:nonNegInt≥1`, `ownerScope:string`, `mac:hex64`.
- **audit event**: `type:'audit-event'`, `eventId/projectIdentity/recordId:uuid`, `previousAuditEventId/previousRecordId:uuid|null`, `previousAuditEventHash:hex64|null`, `recordHash/rawHash/contentHash/keyId:hex64`, `generation/previousGeneration:nonNegInt`, `eventType:enum`, `slot:enum`, `timestamp:rfc3339utc`, `mac:hex64`.
- **journal**: `type:'transaction-journal'`, `transactionId/recordId/auditEventId:uuid`, `projectIdentity:uuid`, `slot:enum`, `candidateGeneration:nonNegInt≥1`, `priorManifestHash:hex64|null`, `state:enum{journal-prepared,record-created,audit-event-created,manifest-committed}`, `recordHash/auditHash:hex64|absent-per-state` (§7), `keyId:hex64`, `mac:hex64`.
- **project binding**: `type:'project-binding'`, `projectIdentity:uuid`, `realpathHash/keyId:hex64`, `ownerScope:string`, `mac:hex64`.
- **lock metadata** (serialized): `type:'trust-lock'`, `transactionId:uuid`, `projectIdentity:uuid`, `slot:enum`, `pid:nonNegInt`, `startedAt:rfc3339utc`, `keyId:hex64`, `mac:hex64` — plus the raw `token` field consumed by secure-fs.

Duplicate-key detection: canonical-byte compare (already) **and** a `JSON.parse` reviver that tracks seen keys per container and throws `record-corrupt` on repeat. Native `JSON.parse` alone is insufficient — hence both.

---

## 9. Correct audit-chain algorithm (§6)

`validateAuditChain(readEvent, head)`:

- **Genesis (generation 1) must terminate with**: `previousAuditEventId === null`, `previousAuditEventHash === null`, `previousGeneration === 0`, `previousRecordId === null`. Terminal acceptance requires `expectedGeneration === 1` **and** all four null.
- **Generation N > 1 requires**: non-null `previousAuditEventId` + `previousAuditEventHash`; `previousGeneration === N - 1`; predecessor's `generation === N - 1`; `previousRecordId` equals the predecessor event's `recordId`; predecessor file `sha256 === previousAuditEventHash`; same `projectIdentity`, `ownerScope`, `slot`; no repeated `eventId` (seen-set); no cycle (seen-set + monotone generation decrement); complete traversal to a valid genesis.
- **Bounded / DoS**: iteration count ≤ `manifest.currentGeneration`; a seen-set of `eventId`s guarantees termination even if a hash somehow matched a cycle; hard cap `MAX_CHAIN` as backstop → `chain-too-long`.
- No attacker-selected early termination: the terminal branch now demands `expectedGeneration === 1`, so a gen-N event claiming genesis is rejected.

---

## 10. Correct journal state machine (§7)

States and rules:

| State | Required fields | Must exist | Must NOT yet exist | Prev state | Next state | Recovery action |
|-------|-----------------|-----------|--------------------|-----------|-----------|-----------------|
| `journal-prepared` | base + `priorManifestHash` | journal | record, audit(this txn), new manifest gen | — | `record-created` | delete (no artifacts to orphan) after schema+MAC+hash checks |
| `record-created` | + `recordHash` | journal, record file (hash matches `recordHash`) | audit(this txn), new manifest gen | prepared | `audit-event-created` | delete journal + orphan record after verifying record hash; never build a manifest |
| `audit-event-created` | + `auditHash` | journal, record, audit event (hash matches) | new manifest gen | record-created | `manifest-committed` | delete journal + orphans after verifying both hashes; never build a manifest |
| `manifest-committed` | + `recordHash`,`auditHash` | manifest at `candidateGeneration` with `currentRecordId === recordId` | — | audit-event-created | (terminal) | verify manifest matches; if match → delete journal (cleanup); if mismatch → `recovery-ambiguous` (fail-closed) |

Recovery preconditions (all states): full journal schema + MAC verified; `projectIdentity`/`slot` match; **all referenced hashes re-verified against on-disk artifacts before any deletion**. A journal that fails schema/MAC → quarantine (`.quarantine` rename), never delete-blind. A **valid old journal whose `candidateGeneration ≤ current manifest generation`** (replay after a newer manifest) → quarantine, never used to create/repair a manifest. Recovery may delete (cleanup) or quarantine; it may **never** synthesize or repair a manifest from a journal. This tightens the current `recover()`, which only special-cases `manifest-committed` and blind-`rm`s all other valid journals without re-verifying referenced hashes.

---

## 11. Lock-token and stale-lock design (§8)

- **Token**: strict RFC 4122 v4 — `/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/` (the harness already uses this constant for its own `assertUuid`; secure-fs must adopt it, replacing `/^[0-9a-f-]{36}$/i`). Alternative accepted: 32-char fixed lowercase hex from `randomBytes(16)`.
- **Lock metadata** (serialized, §8 schema): `format,type:'trust-lock',transactionId,projectIdentity,ownerScope,slot,pid,startedAt,keyId,mac` + `token`. MAC computed by the trust layer (secure-fs stays key-free).
- **Inspection/recovery**: `recover()` reads the lock, applies the strict schema, and **verifies the `trust-lock` MAC** (the trust layer supplies the key; secure-fs exposes a raw read). Malformed/foreign/unauthenticated lock → fail-closed `trust-lock-live`, owner action required.
- **Stale/dead policy — fail-closed** (§8 endorses this over unsafe auto-reclaim):
  - live PID / dead PID / PID-reuse / reboot: **not** auto-distinguished; any present, authenticated lock blocks recovery and requires explicit owner intervention. We do **not** implement automatic dead-lock reclamation, so we owe no PID-reuse/reboot proof.
  - malformed / foreign owner (`ownerScope` mismatch) / foreign key (`keyId` mismatch) / incomplete write: fail-closed, `trust-lock-live` or `trust-lock-foreign`.
  - manual recovery: a documented owner-run step removes the lock after the owner confirms no live transaction; this is the only reclamation path.
  - Windows: `CreateNew` via the hardened helper is the acquisition; release re-reads + constant-time token compare (already implemented) + MAC verify (added).
  - `startedAt` + optional stale-timeout are recorded for **owner-facing diagnostics only**, never for automatic reclamation.

---

## 12. Real crash-test design (§9)

Replace exception injection with a child-process harness:

- `internal/__fixtures__/crash-child.mjs`: takes `{home, project, slot, rawBytes, crashAt}`, runs the real `internal/trust-transaction.js` commit, and at the named boundary calls `process.kill(process.pid, 'SIGKILL')` (POSIX) / `process.exit` is **not** used — Windows uses `child.kill()` / `taskkill /F`. **No `try/finally` and no lock release in the child.**
- Parent spawns the child, waits for the kill, then a **fresh** process inspects the filesystem and runs `recover()` + `isFormat2Authoritative`.
- Boundaries: (1) lock created; (2) journal persisted; (3) record persisted; (4) audit persisted; (5) manifest temp persisted; (6) manifest renamed; (7) manifest readback; (8) journal cleanup; (9) lock-release start.
- Per boundary assert: authority exists? (only ≥6-and-verified); lock remains? (yes for 1–8 until owner acts → `recover` throws `trust-lock-live`); recovery blocked/cleans/quarantines?; orphan cannot authorize; generation cannot be reused (loser never reuses N); a later approval proceeds safely only after owner clears the stale lock.
- This is the direct fix for **B2** and supplies the missing stale-lock evidence for **M3**.

---

## 13. Project-identity resolution (§10)

Recommendation: **Option A for Phase 4A, made explicit and tested; Option B deferred to Phase 4B.**

- Keep one security principal per canonical realpath (current behavior), because the alternative (owner-selected logical label) requires owner-controlled binding UX that only exists once Phase 4B introduces the interactive approval boundary — building it now would smuggle authority-selection logic into 4A.
- Make the claim explicit: document that a canonical physical tree **is** the Phase 4A security principal, and add a **negative test** proving neither repository content nor environment variables can fork or select a second identity (the binding key is `hash(realpathSync)` + owner-side state only). This converts a silent limitation into a stated, tested boundary.
- Phase 1 identity is **not** silently promoted: format-2 bindings are minted fresh (`crypto.randomUUID()`), never derived from Phase 1 paths.
- Option B design recorded for 4B: bind `{realpathHash, projectIdentity (random), ownerLabel}`, one active per session, selected only through owner-controlled state — never repo/env. Option C (separate owner-managed roots) is a superset of B and also deferred.

---

## 14. POSIX durability decision (§11)

**Implement** — the fix is small and correct:
- `writePosixTemporary` already fsyncs the file (`handle.sync()`). Add: after `rename(tmp, file)` in `atomicOwnerOnlyWrite`, `open(dir, O_DIRECTORY|O_RDONLY)` → `fsync` → close the **containing directory**, and fsync any parent directory freshly created by `ensureContainedDir`.
- Ordering: write+fsync temp → rename → fsync dir. This gives process-crash atomicity **and** OS-/power-loss durability for the rename on POSIX.
- Sync variant (`atomicOwnerOnlyWriteSync`) gets the equivalent `fs.opendirSync`/`fsyncSync`.

Separation held: process-crash atomicity (rename is atomic — already true); OS-crash + power-loss durability (dir fsync — added here).

---

## 15. Windows durability and native-test plan (§12, §15)

Windows durability: **narrow the claim explicitly** rather than overstate. Node exposes no `FlushFileBuffers` on a directory handle and no transactional replace with guaranteed parent-dir durability. So for Phase 4A Windows:
- Claim: exclusive `CreateNew` acquisition; file bytes flushed (helper `write` + size readback); atomic replace via move; post-commit readback verification.
- Do **not** claim power-loss durability of the replace on Windows; state it as deferred, with fail-closed recovery (missing/partial manifest → no authority) as the safety net.

Native Windows CI (real runner, not injected adapter):
- concurrent `CreateNew` lock acquisition (one winner);
- ACL owner-only (SYSTEM/Administrators/runner SID) — reuse SEC-03 verifier;
- token-verified + MAC-verified release;
- junction/reparse-point rejection on the final path (native, not adapter);
- case-insensitive path collision;
- process-kill lock leftovers → fresh process sees `trust-lock-live`;
- manifest replacement + readback;
- crash at each transaction boundary (child-process, §12);
- malformed lock → fail-closed.
- Testable in ordinary GitHub Actions: all of the above except any assertion needing power-loss (skipped) or elevated privilege for certain ACL/junction cases (reduced assertion, documented). Reparse-point creation on the runner may need the runner account's `SeCreateSymbolicLinkPrivilege`; where unavailable, assert rejection via a pre-seeded reparse fixture or reduce to the documented skip.

---

## 16. Record-size and inverse M-2 closure (§13)

- **Record-size**: add tests for exactly `MAX_TRUST_RECORD_BYTES` (accepted), `MAX+1` (rejected — exists), a multi-byte UTF-8 payload straddling the boundary (byte-length cap, not char count), and prove the cap is enforced **before** decode/parse (size check precedes `TextDecoder`).
- **Inverse M-2**: construct a full authoritative baseline via the internal transaction, then assert `isFormat2Authoritative` returns `true` **only** for the exact approved raw bytes and `false` for the header-stripped/rendered body (and the converse per the approved raw/rendered tuple). Demonstrates only the exact approved pair authorizes — the M-2 inverse the review requires.

---

## 17. Package-compatibility plan (§13)

- Keep `exports` = `./trust-store` + `./package.json`; do **not** reopen deep writer imports.
- Add tests: supported `import 'noosphere-continuity/trust-store'` resolves (ESM); a CommonJS `require.resolve` (or `import()` from CJS) of the same specifier resolves; `internal/*` deep import rejects with `ERR_PACKAGE_PATH_NOT_EXPORTED`; `npm pack --dry-run` excludes `tests/` and `internal/__fixtures__/` harness (retain existing) yet **includes** `continuity/internal/` production modules (so 4B can import them). Package-root import behavior verified against the packed artifact.

---

## 18. Proposed corrective commit series (§14)

**Option 3 — short corrective series** (preferred; architecture, crash tests, and binding warrant separable review). Replace `6b7c8287` on a fresh `codex/sec-05-phase-4a` (or stack on it) with:

**4A-R1 — Extract strict reusable internal primitives**
- `continuity/internal/*` modules (§6); `strict-schema.js` framework (§8) with exact schemas; complete audit-chain (§9); journal state machine (§7); strict lock token (§11) in `noosphere-secure-fs`. Harness reduced to a fixtures adapter importing `internal/*`. Tests re-pointed to internal modules. Boundary tests extended (§7, §17).

**4A-R2 — Real crash/recovery and durability**
- Child-process crash harness (§12); authenticated lock inspection + fail-closed stale policy (§11); POSIX parent-dir fsync (§14); Windows-native trust-v2 CI job (§15).

**4A-R3 — Project binding and boundary closure**
- Option-A identity made explicit + negative repo/env test (§13); package ESM/CJS/root compatibility tests (§17); exact record-size + multibyte + inverse-M-2 tests (§16).

Review/merge order: R1 → R2 → R3 (R2 depends on R1's internal modules; R3 depends on both). Each merges only after its own focused suite is green on Linux/macOS, with the Windows-native job gating R2/R3.

---

## 19. Exact test plan

- **Schema** (`trust-strict-schema.test.js`): fatal-UTF8 reject; BOM reject; duplicate-key reject (reviver + canonical); unknown-field reject; each field validator positive+negative; RFC3339 non-UTC/format reject; size-cap-before-decode.
- **Audit** (`trust-audit.test.js` extended): genesis must be gen 1 + all `previous* === null`; gen-N linkage (previousGeneration, predecessor recordId, predecessor hash); truncated/substituted/cyclic chain rejected; `chain-too-long`; orphan audit confers no authority (exists).
- **Transaction/crash** (`trust-crash.test.js`, child-process): 9 boundaries × {authority?, lock remains?, recovery outcome, no orphan authority, no generation reuse, safe later approval}. No `finally` in child.
- **Journal** (`trust-journal.test.js`): each state's required-exist / must-not-exist; replay-after-newer-manifest → quarantine; malformed → quarantine; committed-mismatch → `recovery-ambiguous`; no manifest ever synthesized from a journal.
- **Lock** (`trust-lock.test.js`): strict-UUID accept, loose-token (36 hyphens) reject; MAC-verified inspection; foreign owner/key fail-closed; token-mismatch release reject (exists).
- **Durability** (`secure-persistence.test.js` extended): POSIX dir-fsync invoked on write+rename (spy/mock on the dir handle); Windows readback size/verify.
- **Binding/identity** (`trust-project-binding.test.js`): same-realpath → same principal (documented); repo-content and env cannot fork/select identity; Phase 1 path never promoted.
- **Boundary/package** (`trust-api-boundary.test.js` extended): `internal/*` deep import rejects; harness/tests excluded from pack; `continuity/internal/` included in pack; ESM + CJS resolution of `./trust-store`.
- **Size/M-2** (`trust-store-hardening.test.js` extended): exact-MAX accept; MAX+1 reject (exists); multibyte-straddle; inverse-M-2 exact-pair-only authority.

---

## 20. Re-review gates

Ready for the next hostile review only when **all** hold:
1. Security-critical logic is in `continuity/internal/*`, no longer test-only.
2. Tests import and exercise those exact internal modules (what 4B will call).
3. Strict schemas reject fatal-UTF8/BOM/dup-key/unknown-field/bad-timestamp/bad-enum.
4. Complete audit chain validated (genesis pinned to gen 1; full linkage; bounded).
5. Journal enforces legal states/transitions; no manifest synthesized from a journal; replay quarantined.
6. Strict lock tokens (RFC 4122 / fixed hex); authenticated lock inspection.
7. Fail-closed stale-lock behavior, explicit + tested.
8. Real process-death (SIGKILL / forceful Windows) tests at every boundary, no `finally` cleanup in child.
9. Project-identity collision resolved (Option A explicit + negative test) or Option B implemented.
10. Durability precisely implemented (POSIX dir fsync) or narrowed (Windows power-loss deferred), recovery fail-closed.
11. Linux/macOS/Windows focused suites green.
12. No production authority writer reachable via exports/deep-import/CLI/MCP/adapters.
13. No new user-facing authority transition.
14. Phase 1–3 behavior unchanged.
- **ACP investigation**: the unrelated ACP durable-lineage/offline-queue failures must be shown independent of secure-fs changes. Evidence line: the secure-fs diff adds only `acquireOwnerOnlyLock` + `timingSafeEqual` import; ACP failures reproduce on base `ad7b88b` (pre-Phase-4A) and touch no lock API. Confirm by running the ACP suite on `ad7b88b` vs `6b7c8287` and diffing failures (expected identical). Do not fix ACP inside SEC-05 unless causally linked.

---

## 21. Work explicitly deferred to Phase 4B/4C

- Interactive owner-approval boundary / `approve-source`; the in-process trusted approval service that will import `internal/*`.
- Option B owner-selected logical project labels (identity switch).
- Restore application, revocation, migration, summary provenance.
- Any new authority-bearing sink; MCP authority mutation.
- Phase 5 replay/freshness behavior.
- Windows power-loss durability proof (helper-backed `FlushFileBuffers`/transactional replace).
- Automatic dead-lock reclamation with PID-reuse/reboot discrimination (only if ever needed; current stance is fail-closed).

Corrected Phase 4A still has **no** user-facing authority transition.

---

## 22. Final remediation decision

The Phase 4 **design** is sound and preserved. The reviewed commit's defects are: authority logic stranded in a package-excluded test harness (B1), crash tests that never crash (B2), and bounded structural/durability/identity gaps (M1–M5) — all fixable by the architecture-preserving R1→R2→R3 series without introducing any new authority transition. The plan is complete and implementation-ready.

**PHASE 4A REMEDIATION PLAN APPROVED**
