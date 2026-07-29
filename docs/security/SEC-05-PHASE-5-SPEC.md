# SEC-05 Phase 5 — Persistent Replay Detection and Closure

**Status:** Proposed security specification
**Phase:** 5 of 5 (final SEC-05 phase)
**Implementation status:** Approved for test-first implementation after this specification and its implementation plan are committed
**Target baseline:** SEC-05 Phases 1–4C, including the reviewed Phase 4C remediation at `7004a3a`
**Normative terms:** “MUST”, “MUST NOT”, “SHALL”, “SHALL NOT”, “SHOULD”, and “MAY” are normative.

## 1. Purpose

Phase 5 adds persistent, bounded replay detection to recalled memory. It closes
SEC-05 attacks A8, A12, and A13 by detecting repeated recall content across
sessions, suppressing duplicate typed restore candidates, labeling replayed and
stale ordinary recall, and preserving bounded authenticated evidence.

Phase 5 is about replay observation only. It creates no authority and changes no
authority decision.

The following invariant governs the entire phase:

> Replay state MUST NEVER influence authority.

Every normative claim in this specification is mapped to a test requirement in
§22.

## 2. Inherited security invariants

Phase 5 MUST preserve every invariant and boundary established by Phases 1–4C.
In particular, it MUST NOT weaken:

1. irreversible format-1 retirement;
2. append-only format-2 authority generations;
3. canonical MAC verification and record-domain separation;
4. owner-local, non-repository project identity;
5. explicit owner approval as the only authority-minting operation;
6. authenticated append-only revocation;
7. restore staging as untrusted, bounded evidence;
8. one-shot restore confirmation and apply;
9. replay-safe restore recovery;
10. current-manifest-only authority selection;
11. internal writer/package boundaries;
12. CLI and MCP authority boundaries;
13. quote-unless-authenticated rendering;
14. the accepted residual that terminal attachment is not human-presence proof;
15. the accepted residual for wholesale owner-local security-store rollback.

Phase 5 code MUST NOT modify the format-2 manifest schema, generation records,
audit events, revocation tombstones, restore candidate envelopes or state,
restore confirmations, apply journals, receipts, consumed markers, or their
transition rules. Replay identity and candidate identity are completely
separate: no replay artifact may persist a candidate identifier or path, and no
candidate artifact may persist a replay identity, replay path, or replay
reference. Existing Phase 4C artifacts MUST remain readable without migration.

## 3. Scope

### 3.1 In scope

Phase 5 SHALL:

- detect identical replay objects across sessions;
- persist bounded replay evidence;
- classify observations as `NEW`, `SEEN`, `REPLAYED`, or `SUPPRESSED`;
- suppress creation of duplicate active typed restore candidates;
- report when an identical typed candidate was already consumed;
- label replayed ordinary recall results;
- label stale or time-unverifiable ordinary recall results;
- preserve ordinary recall ordering and content evidence;
- serialize concurrent replay observations;
- recover interrupted replay-ledger updates idempotently through production
  replay-observation paths;
- expose bounded, read-only replay inspection;
- close SEC-05 documentation and release tracking only after every gate passes.

### 3.2 Out of scope

Phase 5 SHALL NOT:

- approve, reapprove, or promote content;
- revoke content;
- restore authority;
- infer authority from replay state;
- alter a format-2 authority decision;
- replace or repair format-2 state;
- select the current format-2 generation;
- create a second authority database;
- add server-issued authenticated recall receipts;
- authenticate remote authorship;
- trust remote timestamps, ranking, labels, or trust claims;
- silently discard ordinary recalled information;
- expose replay mutation through MCP, HTTP, package exports, hooks, lifecycle
  services, adapters, or the relayer.
- expose replay-key reset, rotation, reinitialization, import, or repair.

## 4. Security invariants

The implementation MUST enforce all of the following.

### RPL-I01 — authority independence

Authority continues to be the pure result of the existing authenticated
format-2 manifest and exact live slot bytes. Replay records, replay journals,
replay locks, replay classifications, replay retention state, and replay
failures are never inputs to `isSlotAuthoritative`, manifest selection, approval,
revocation, restore apply, or recovery.

### RPL-I02 — deletion independence

Deleting any replay file, project replay directory, replay key, replay journal,
or the entire replay root MUST NOT cause any byte sequence to become
authoritative or non-authoritative. The authority result before and after replay
deletion MUST be identical.

### RPL-I03 — corruption independence

Malformed, noncanonical, oversized, MAC-invalid, domain-invalid, rolled-back,
or conflicting replay state MUST NOT change authority. It fails replay
detection only.

### RPL-I04 — no authority operation

No replay mutation may approve, revoke, select a generation, write an authority
manifest, create an authority audit event, stage authority bytes, apply a
candidate, spend a confirmation, commit a receipt, or consume a candidate.

### RPL-I05 — monotonic replay state

For one replay identity, the only logical states are:

```text
NeverSeen -> SeenOnce -> Replayed
```

No state transition moves backward. Retention removes bounded replay evidence;
it does not perform a reverse state transition and has no authority meaning.

### RPL-I06 — domain separation

Replay records, manifests, catalogs, journals, compaction checkpoints, and locks
use replay-only authenticated domains. A replay artifact MUST fail verification
as an authority record, restore candidate, confirmation, state-machine record,
apply journal, receipt, consumed marker, audit event, tombstone, or manifest.
The inverse substitutions MUST also fail.

### RPL-I07 — bounded evidence, no payload

The replay store contains digests and bounded event metadata only. It MUST NOT
contain complete recalled payloads, excerpts, prompts, instructions, summaries,
or credentials.

### RPL-I08 — fail closed for replay

When replay state cannot be safely read, authenticated, locked, retained, or
recovered:

- typed restore staging fails with a replay-security refusal before creating a
  new candidate;
- ordinary recall remains visible, quoted, and non-authoritative, with replay
  status `UNAVAILABLE`;
- existing authority reads and decisions continue unchanged.

### RPL-I09 — no remote control over identity

Remote timestamps, ranking, presentation order, agent labels, action labels,
origin labels, trust claims, and display metadata are excluded from the replay
identity.

### RPL-I10 — no silent ordinary suppression

Replay classification never removes an item from ordinary context recall.
Every item returned by the bounded recall response remains represented in the
same relative order.

### RPL-I11 — identity separation

Replay identity is a deterministic digest of project, trusted local slot, and
normalized recalled bytes. Candidate identity remains the independently random
canonical Phase 4C candidate ID. Neither identity may be derived from the other,
and neither security store may persist a cross-reference to the other. A live
typed-staging orchestrator may pass only the trusted local matching tuple
`(projectIdentityDigest, localSlot, candidatePayloadHash)` between the two
independently authenticated domains.

### RPL-I12 — production-reachable recovery

Replay-journal recovery MUST be reached automatically by every production
operation that can mutate replay state, before that operation observes new
content. Recovery MUST NOT exist only as a test helper or direct internal test
entry point. Read-only inspection reports incomplete recovery state but never
performs recovery. If process death leaves a replay lock artifact, the first
production retry MUST fail closed without deleting it. After the owner has
independently established that no operation is live and removed the lock
artifact, the next normal production retry MUST reach recovery automatically.

### RPL-I13 — global lock hierarchy

Every replay and typed-restore duplicate-exclusion lock participates in the
single rank order defined in §11. No code path may acquire a lower-ranked lock
while holding a higher-ranked lock. Same-rank multi-lock acquisition uses
canonical lexical lock-key order. Replay observation and candidate
duplicate-exclusion locks MUST be released before restore apply or authority
transaction locks are acquired.

### RPL-I14 — no replay-key reinitialization

Phase 5 provides no replay-key reinitialization, rotation, reset, recovery,
import, or repair operation. First-use key creation is permitted only for a
pristine replay root containing no replay catalog, project, record, journal, or
checkpoint state. Key loss or replacement while any replay state survives fails
replay closed and is never repaired automatically.

## 5. Trust-domain model

Phase 5 introduces a fifth security domain:

1. repository/project content;
2. owner-local authenticated format-2 authority;
3. owner-local restore staging and apply evidence;
4. untrusted semantic recall and rendered context;
5. **owner-local replay ledger**.

The replay ledger is observational security state. It is neither authority nor
restore state.

### 5.1 Location

The default replay root is:

```text
${NOOSPHERE_HOME}/replay-v1/
```

Within it:

```text
replay-v1/
  machine.key
  catalog.json
  catalog.lock
  projects/
    <projectIdentityDigest>/
      manifest.json
      ledger.lock
      records/
        <replayIdentity>.json
      locks/
        <replayIdentity>.lock
      journals/
        <operationId>.json
      retention/
        checkpoint.json
```

The root is:

- owner-local;
- outside every project tree;
- outside `.noosphere/`;
- outside `trust-v2/`;
- outside restore staging;
- excluded from repository, Walrus, project backup, import, and restore.

Every directory and file uses the existing SEC-03 no-follow, owner-only,
bounded-read, atomic-replacement primitives. Symlinks, non-regular files,
hard-linked sensitive files, unsafe ancestors, foreign ACLs/modes, and
unreadable paths fail replay closed.

### 5.2 Replay key

`replay-v1/machine.key` is a replay-only random 256-bit key:

- created exclusively with owner-only permissions;
- never stored in the authority root;
- never accepted from a project, recall result, restore, backup, environment
  value, CLI argument, or remote service;
- never logged or returned;
- never used to MAC authority or restore artifacts;
- never used by authority readers.

First-use key creation is allowed only when the replay root is pristine. If a
catalog, project directory, record, manifest, journal, retention checkpoint, or
other replay artifact survives without the original key, or is authenticated by
a different key, replay fails closed. Recovery MUST NOT create a key, re-MAC old
state, or discard state.

Phase 5 intentionally provides no supported key reinitialization, rotation,
reset, repair, backup, restore, or import path. Owner remediation is
out-of-band. Wholesale deletion of the complete replay root is
indistinguishable from a first installation; a later production use may create
a new root and key. The resulting loss of replay history is an accepted
rollback/deletion residual and has no authority effect.

### 5.3 One-way project identity dependency

The replay subsystem consumes the existing canonical
`projectIdentityDigest` through a read-only identity interface. It MUST NOT
create, replace, repair, select, or mutate the format-2 project binding.

If canonical project identity cannot be read safely:

- replay detection is `UNAVAILABLE`;
- typed restore staging refuses before recall evidence becomes a candidate;
- ordinary recall remains quoted and visible;
- authority behavior is unchanged.

No replay field is read by the authority subsystem. Static dependency tests
MUST enforce this one-way boundary.

## 6. Canonical replay identity

### 6.1 Canonical content equivalence

Two recall objects are equivalent for replay purposes exactly when all three are
equal:

1. canonical `projectIdentityDigest`;
2. canonical local slot;
3. canonical normalized payload bytes.

The canonical local slot is selected by trusted local code, not a remote label:

```text
master-prompt
instructions
baseline
followups
ordinary
```

For typed restore, the slot comes from the owner's CLI argument and the existing
`RESTORE_SLOTS` map. For ordinary recall it is `ordinary`. A remote
`action_type` may be validated against the locally selected typed slot, but it
never selects the slot.

Canonical normalized payload bytes are:

```text
UTF8(normalizeUntrusted(exact recalled UTF-8 string))
```

using the current registered SEC-05 normalizer. Invalid UTF-8, an empty typed
payload, or an oversized typed payload is rejected by the existing restore
boundary before replay observation. Ordinary recall with malformed content is
rendered as a bounded invalid observation and never passed to the replay writer.

### 6.2 Exact digest construction

Let:

```text
payloadDigest =
  "sha256:" + lowercaseHex(
    SHA-256(canonicalNormalizedPayloadBytes)
  )
```

Let `canonicalJson` be the existing SEC-05 canonical JSON encoder. The replay
identity is:

```text
replayIdentity =
  "sha256:" + lowercaseHex(
    SHA-256(
      UTF8(
        canonicalJson([
          "noosphere.replay-identity.v1",
          projectIdentityDigest,
          slot,
          payloadDigest
        ])
      )
    )
  )
```

Timestamps, rankings, response positions, agent IDs, action IDs, blob IDs,
remote action types, remote origin/trust claims, distances, and display metadata
MUST NOT appear in this digest input.

The test definition of “different content” is “different canonical normalized
payload bytes within the same project and slot.” Such content MUST produce a
different replay identity, except for the accepted cryptographic residual of a
SHA-256 collision.

### 6.3 Recall identity

`recallIdentity` is bounded audit metadata, not replay identity and not
authority. It is:

```text
"sha256:" + lowercaseHex(
  SHA-256(
    UTF8(
      canonicalJson([
        "noosphere.remote-recall-identity.v1",
        validActionIdOrNull,
        validBlobIdOrNull,
        payloadDigest
      ])
    )
  )
)
```

`action_id` and `blob_id` are accepted only as bounded UTF-8 strings. Invalid or
oversized values become `null`; they never fail or alter the content-based
replay identity. When both are absent, `payloadDigest` still makes the audit
identity deterministic.

## 7. Replay state machine and classification

### 7.1 Persistent states

The persistent state derives exclusively from `replayCount`:

| Count | State |
|---:|---|
| no record | `NeverSeen` |
| `1` | `SeenOnce` |
| `>= 2` | `Replayed` |

`replayCount` is an unsigned safe integer from `1` through
`Number.MAX_SAFE_INTEGER`. An attempted increment beyond the bound fails replay
closed; it never wraps or saturates silently.

### 7.2 Observation classifications

Classifications describe the current observation:

| Prior state | Current operation | Returned classification | New state |
|---|---|---|---|
| `NeverSeen` | any valid observation | `NEW` | `SeenOnce` |
| `SeenOnce` | ordinary observation | `SEEN` | `Replayed` |
| `Replayed` | ordinary observation | `REPLAYED` | `Replayed` |
| `SeenOnce` or `Replayed` | typed duplicate with an active or consumed candidate | `SUPPRESSED` | `Replayed` |

`SUPPRESSED` means only “a new duplicate candidate was not created.” It does not
mean content is trusted, untrusted, approved, revoked, current, or stale.

The stored record contains `lastClassification`. A classification is
informational and MUST NOT be accepted by an authority API.

## 8. Replay record schema

Every record is canonical JSON, bounded to 16 KiB, MAC-authenticated with the
replay key, and contains exactly:

```json
{
  "domain": "noosphere.replay.record.v1",
  "schema": "noosphere.replay-record",
  "version": 1,
  "replayIdentity": "sha256:<64 lowercase hex>",
  "projectIdentityDigest": "<canonical Phase 4C project digest>",
  "slot": "master-prompt|instructions|baseline|followups|ordinary",
  "payloadDigest": "sha256:<64 lowercase hex>",
  "recallIdentity": "sha256:<64 lowercase hex>",
  "firstSeen": {
    "eventId": "<canonical UUIDv4>",
    "observedAt": "<UTC RFC3339 milliseconds>",
    "recallIdentity": "sha256:<64 lowercase hex>"
  },
  "lastSeen": {
    "eventId": "<canonical UUIDv4>",
    "observedAt": "<UTC RFC3339 milliseconds>",
    "recallIdentity": "sha256:<64 lowercase hex>"
  },
  "replayCount": 1,
  "state": "SeenOnce|Replayed",
  "lastClassification": "NEW|SEEN|REPLAYED|SUPPRESSED",
  "origin": "walrus-recall|local-file-recall",
  "recordGeneration": 1,
  "keyId": "<replay-key identifier>",
  "mac": "<lowercase replay-domain MAC>"
}
```

Rules:

- `firstSeen` is immutable.
- `lastSeen` is replaced by the newest committed local observation.
- `observedAt` is generated by the local process; remote timestamps never
  populate it.
- Per identity, `lastSeen.observedAt` is
  `max(localNow, previous.lastSeen.observedAt)` so local clock rollback cannot
  move it backward.
- `recordGeneration` starts at `1` and increments exactly once per committed
  observation.
- `replayCount` increments exactly once per committed observation.
- `state`, `lastClassification`, `recordGeneration`, and `replayCount` must be
  mutually consistent.
- `origin` comes from the configured local memory backend, never the record's
  remote origin field.
- Unknown, omitted, inherited, duplicate, noncanonical, or out-of-bound fields
  fail replay closed.

No record stores recalled content.

## 9. Catalog, manifest, and retention checkpoint

### 9.1 Owner catalog

`catalog.json` is a replay-domain authenticated catalog of project identity
digests previously initialized under this replay key. It detects deletion of one
project replay directory while the replay root remains intact.

If the catalog names a project whose replay manifest is absent, replay is
`UNAVAILABLE` for that project. The subsystem MUST NOT silently recreate an
empty ledger.

### 9.2 Project manifest

`manifest.json` contains:

- replay domain/schema/version;
- project identity digest;
- exact current record count;
- digest of the sorted `(replayIdentity, recordGeneration, record MAC)` index;
- retention generation;
- retention checkpoint digest;
- last successful recovery time;
- key ID and replay-domain MAC.

The manifest is never an authority manifest and MUST fail verification in the
authority manifest domain.

### 9.3 Retention checkpoint

`retention/checkpoint.json` is the authenticated equivalent of deletion
markers. It contains:

- retention generation;
- total evicted record count;
- most recent retention time;
- maximum age and record-count policy identifiers;
- an accumulator:

```text
accumulator_N = SHA-256(
  canonicalJson([
    "noosphere.replay-retention.v1",
    accumulator_(N-1),
    replayIdentity,
    finalRecordGeneration,
    finalReplayCount,
    finalState,
    lastSeen.observedAt,
    evictionReason
  ])
)
```

The checkpoint proves that authenticated evidence was deliberately compacted
under the fixed retention policy. It does not retain payloads and cannot be used
to classify an evicted identity.

## 10. Observation transaction

Every replay observation is one transaction:

1. validate and normalize the recalled content;
2. derive project identity, slot, payload digest, replay identity, and recall
   identity without reading replay classification;
3. enter the production replay-operation boundary;
4. acquire the replay project lock and then each affected replay identity lock;
5. recover every authenticated incomplete journal that can affect the locked
   project/identities before observing the new event;
6. re-read and authenticate catalog, manifest, retention checkpoint, and current
   record while both locks are held;
7. compute the exact next record and exact next manifest;
8. create an authenticated `prepared` journal containing the before digests and
   complete intended after digests;
9. atomically replace or exclusively create the replay record;
10. append journal state `record-committed`;
11. atomically replace the project manifest;
12. append journal state `manifest-committed`;
13. append journal state `complete`;
14. release the identity lock, then the project ledger lock;
15. return the observation classification.

No step calls an authority or restore writer.

For typed staging, the production orchestration boundary owns an opaque ranked
lock scope. The replay observer commits inside ranks 20 and 30 without releasing
that scope; orchestration then acquires rank 40 and invokes the restore
match/create adapter. The adapter receives no replay identity. This preserves
atomic duplicate exclusion without creating a replay-to-restore writer import.
Non-staging observations release ranks 30 and 20 at step 14.

Recovery is part of the production replay-operation boundary used by
`restore stage`, structured ordinary recall, and typed context refresh. A
test-only caller is insufficient. Recovery never runs from `replay status` or
`replay list`; those readers are byte-for-byte read-only and report incomplete
journals as unhealthy.

## 11. Concurrency

Replay updates serialize on replay identity and project manifest.

Concurrent valid observations of one never-seen identity MUST produce:

- one record, not multiple records;
- one immutable first-seen event;
- a replay count equal to the number of committed observations;
- the latest committed local last-seen event;
- monotonically increasing record generations;
- state `Replayed` when the count is at least two.

No count, first-seen event, last-seen event, manifest update, or retention
update may be lost.

Concurrent typed staging of identical `(project, slot, normalized payload)` MUST
create at most one active restore candidate.

### 11.1 Global replay–restore lock hierarchy

Every participating lock has exactly one rank:

| Rank | Lock | Canonical lock key |
|---:|---|---|
| 10 | replay catalog initialization lock | `replay-catalog` |
| 20 | replay project/ledger lock | `replay-project:<projectIdentityDigest>` |
| 30 | replay identity lock | `replay-identity:<projectIdentityDigest>:<replayIdentity>` |
| 40 | restore candidate-index lock | `restore-candidate-index:<projectIdentityDigest>:<slot>:<candidatePayloadHash>` |
| 50 | restore candidate-state lock, when required | `restore-candidate:<candidateId>` |
| 60 | existing format-2 slot/authority transaction lock | existing canonical authority key |

Acquisition is strictly ascending by rank. A caller holding a rank MUST NOT
acquire any lower rank. Multiple locks at one rank are acquired in canonical
lexical lock-key order and released in reverse order. Lock acquisition passes
through one internal rank-checking helper; test and production code use the same
helper.

Live typed staging acquires ranks 20, 30, and 40 in that order and holds the
candidate-index lock across authenticated match and exclusive candidate
creation. Candidate-state locking, if needed, follows at rank 50. Replay,
candidate-index, and candidate-state locks MUST all be released before any
restore apply, confirmation-spend, receipt, consumed-marker, format-2 slot, or
authority transaction at rank 60 begins. Authority and apply/recovery paths
never acquire replay locks.

The candidate-index lock belongs to the restore domain, is keyed by the trusted
local matching tuple, and is independent of the randomly generated candidate
ID. It prevents two concurrent staging operations from creating duplicate
active candidates without making replay state authoritative for candidate
lifecycle.

### 11.2 Lock artifact policy

Replay lock files:

- use the replay key and `noosphere.replay.lock.v1` domain;
- bind project identity and, for identity locks, replay identity;
- use strict canonical UUID owner tokens;
- are owner-only and no-follow;
- are never automatically deleted based on PID age, timestamp, boot time, or
  presumed staleness.

Candidate-index locks use a distinct restore-authenticated lock domain and
strictly bind project identity, trusted local slot, and candidate payload hash.
Every present or unusable replay or candidate-index lock requires owner
intervention. A surviving crash lock therefore blocks journal recovery until
the owner independently establishes that no operation is live and removes the
lock artifact; the next production mutation then enters the ordinary recovery
boundary. Lock policy has no effect on authority locks.

## 12. Crash journal and recovery

Replay journals use domain `noosphere.replay.journal.v1`, schema
`noosphere.replay-journal`, and version `1`.

Journal states are:

```text
prepared
record-committed
manifest-committed
complete
```

Each state transition is authenticated, canonical, append-only, and legal only
from its immediate predecessor.

The prepared journal binds:

- operation ID;
- project identity digest;
- replay identity;
- event ID;
- prior record digest or authenticated absence;
- prior manifest digest;
- complete intended next record digest;
- complete intended next manifest digest;
- intended replay count, record generation, state, and classification;
- local observed time;
- key ID.

Recovery:

- runs only while holding the replay project and identity locks;
- authenticates the complete journal chain and all named artifacts;
- distinguishes exact before-state from exact after-state;
- writes an intended artifact only when the current artifact is the exact
  authenticated before-state;
- treats the exact intended after-state as already committed;
- refuses every third state as ambiguous;
- appends missing journal transitions idempotently;
- never increments a count twice for one journal event ID;
- never rewrites `firstSeen`;
- never touches authority or restore state.

Production reachability is mandatory:

- `restore stage <slot>` invokes recovery before replay observation and before
  candidate matching or creation;
- structured ordinary recall invokes recovery before replay observation;
- typed context refresh invokes recovery before replay observation;
- after process death, a retry with a surviving lock refuses without mutation;
  after explicit owner lock intervention, a normal production retry reaches
  the same recovery code without importing an internal recovery helper
  directly;
- read-only replay inspection detects and reports incomplete journals but does
  not recover them.

Recovery can repair only an interrupted authenticated replay transaction. It
cannot recreate a missing replay key, accept a replacement key, re-MAC prior
state, create or consume a candidate, or mutate authority.

Malformed, spliced, rolled-back, missing-required, conflicting, or
noncanonical journals fail replay closed and require owner intervention.

## 13. Typed restore behavior

This section applies to `restore stage <slot>`.

### 13.1 Ordering

After the existing recall response, action-type, UTF-8, size, and slot checks
pass, but before creating a restore candidate:

1. derive and commit the replay observation;
2. while respecting ranks 20 → 30 → 40, ask the independently authenticated
   restore candidate store for candidates matching only the trusted local
   `(projectIdentityDigest, slot, candidatePayloadHash)` tuple;
3. the restore store—not the replay record—decides whether a matching candidate
   is active, apply-in-progress, or consumed.

Candidate IDs are generated randomly by the existing Phase 4C candidate store
after duplicate matching. They MUST NOT be replay identities or deterministic
derivatives of recalled content. Replay records, manifests, catalogs, journals,
locks, and checkpoints MUST NOT contain candidate IDs or candidate paths.
Candidate envelopes, payload metadata, state, receipts, and consumed markers
MUST NOT contain replay identities, replay paths, or replay references. Neither
store persists the ephemeral matching tuple as a cross-domain reference.

### 13.2 Duplicate outcomes

- If no authenticated matching candidate exists, stage exactly one new
  untrusted candidate through the existing Phase 4C staging service.
- If one authenticated active matching candidate exists, do not create another;
  return that candidate with replay classification `SUPPRESSED`.
- If the authenticated matching candidate is apply-in-progress, refuse with
  owner intervention; do not create another.
- If an authenticated matching candidate is consumed, do not create another;
  return a bounded `already-consumed` result containing only its candidate ID,
  outcome, and replay classification `SUPPRESSED`.
- If multiple, conflicting, malformed, or unsafe matching candidate artifacts
  exist, fail closed before staging.

Candidate state is authoritative only for candidate lifecycle, never for
content authority.

### 13.3 Atomic duplicate exclusion

The replay project/identity locks and restore candidate-index lock remain held
through the restore-store match-and-create decision. Restore candidate creation
continues to use the existing restore store and schemas. A new candidate, if
created, is then re-read and authenticated before locks are released in reverse
rank order.

An interrupted operation may leave a valid replay observation without a
candidate. Retry may create the missing candidate after recovery. It MUST NOT
leave two active candidates.

Replay-journal recovery never creates, consumes, applies, or selects a candidate.
Candidate creation belongs only to the live typed staging operation.

## 14. Typed context fallback

The existing baseline, master-prompt, and follow-up recall used by context
refresh is observational, not candidate staging.

- Each valid typed result is recorded with its trusted local slot.
- The rendered section includes replay classification.
- A repeated result is not silently removed.
- Existing quote-unless-authenticated behavior remains unchanged.
- Replay classification is not passed to `isSlotAuthoritative`.
- A current exact format-2 match, where already permitted by the inherited
  authority rules, is decided exclusively by the authority store and exact
  bytes—not by replay state.

## 15. Ordinary recall behavior

### 15.1 Structured ingestion

Local clients that label replay MUST consume the existing structured recall
response rather than attempting to parse the prompt-ready text route.

For each bounded ordinary result, in the relayer-provided order:

1. validate the response envelope and bounded memory object;
2. normalize content for replay identity;
3. commit one replay observation under slot `ordinary`;
4. calculate freshness from remote timestamp as informational metadata;
5. render the original bounded content through the existing untrusted quoting
   path with replay and freshness labels.

The relayer itself remains replay-ledger unaware and exposes no replay writer.

### 15.2 Ordering and non-suppression

Replay processing MUST NOT resort ordinary results. Semantic distance, server
ordering, and presentation order are preserved exactly as received after
invalid objects are represented by an explicit bounded invalid-evidence entry.

Duplicate ordinary results remain visible. Each carries one of:

```text
Replay: NEW
Replay: SEEN
Replay: REPLAYED
Replay: UNAVAILABLE
```

### 15.3 Freshness labels

Freshness is informational and not part of replay identity or authority.
Relative to the local observation time:

- `CURRENT`: a canonical remote timestamp is no more than 30 days old and no
  more than 5 minutes in the future;
- `STALE`: a canonical remote timestamp is more than 30 days old;
- `TIME_UNVERIFIED`: timestamp absent, malformed, noncanonical, or more than
  5 minutes in the future.

Clock failure yields `TIME_UNVERIFIED` and does not hide content.

Remote timestamp affects only this label. It does not change replay state,
retention, ordering, candidate selection, or authority.

## 16. Retention

### 16.1 Fixed limits

Per canonical project identity:

- maximum live replay records: **4,096**;
- maximum record age: **90 days** since local `lastSeen.observedAt`;
- maximum replay record size: **16 KiB**;
- maximum project manifest, catalog, journal, or retention checkpoint size:
  **64 KiB** each;
- completed journal retention: **7 days**, bounded to **1,024** journals;
- incomplete authenticated journals are never evicted automatically.

These constants are schema-policy identifiers and cannot be changed by project
configuration, environment variables, remote metadata, or recall content.

### 16.2 Deterministic eviction

Retention runs under the replay project lock before creating a new identity and
at most once per hour for existing identities.

Eviction order is:

1. completed journals older than seven days, sorted by
   `(completedAt, operationId)`;
2. replay records older than 90 days, sorted by
   `(lastSeen.observedAt, replayIdentity)`;
3. if more than 4,096 records remain, the same sorted order until exactly 4,095
   remain before insertion of a new identity.

Each replay-record eviction is incorporated into the authenticated retention
accumulator and committed manifest before the record is removed. A crash during
retention uses a replay retention journal with the same exact-before/exact-after
rules as §12.

Retention:

- never reads or writes authority;
- never creates or consumes a restore candidate;
- never changes a replay classification for a retained record;
- never uses remote timestamps, ranking, labels, or trust claims.

After authenticated eviction, a later identical observation may be classified
`NEW`; the retention checkpoint still proves bounded evidence was compacted.
This bounded-memory trade-off is an accepted residual, not authority restoration.

## 17. Failure semantics

| Failure | Typed restore | Ordinary recall | Authority |
|---|---|---|---|
| replay root unsafe | refuse before staging | show quoted content with `UNAVAILABLE` | unchanged |
| replay key missing with existing state | refuse | `UNAVAILABLE` | unchanged |
| record/schema/MAC/domain invalid | refuse | `UNAVAILABLE` | unchanged |
| journal invalid or ambiguous | refuse | `UNAVAILABLE` | unchanged |
| replay lock present/unusable | refuse | `UNAVAILABLE` | unchanged |
| candidate-index lock present/unusable | refuse before match/create | not applicable | unchanged |
| identity unavailable | refuse | `UNAVAILABLE` | unchanged |
| retention conflict/failure | refuse new candidate | `UNAVAILABLE`; content visible | unchanged |
| local clock invalid | refuse typed observation | `TIME_UNVERIFIED`; content visible | unchanged |
| complete replay root deleted | next normal replay operation may perform pristine first-use creation; prior detection lost | items may become `NEW` | unchanged |

Replay errors use a dedicated error family and MUST NOT be mapped to authority
success, approval refusal, revocation success, restore success, or candidate
consumption.

## 18. Threat model

### 18.1 Attacker capabilities

The Phase 5 attacker may:

- submit arbitrary recalled payloads;
- repeat identical payloads under different action IDs, blob IDs, timestamps,
  labels, rankings, or order;
- flood the recall namespace with distinct payloads;
- race multiple local recall consumers;
- crash the local process at any replay write boundary;
- corrupt or delete project-controlled content;
- present malformed replay-shaped files if they can write local replay state
  through an already-compromised same-user process;
- roll back individual replay artifacts;
- manipulate remote timestamps and metadata.

The attacker cannot forge the owner-local replay key without the same-user
local capability already outside SEC-05.

### 18.2 Attack handling

| Attack | Required result |
|---|---|
| replay flooding | fixed record/size/age bounds; deterministic authenticated compaction |
| duplicate recall injection | same replay identity despite changed remote metadata |
| replay rollback | partial rollback detected by manifest/journal/digest mismatch; replay fails closed |
| project ledger deletion | catalog mismatch makes replay unavailable |
| complete replay-root deletion | detection may reset; authority is byte-for-byte unchanged |
| ledger corruption | replay unavailable; ordinary content visible and quoted; authority unchanged |
| replay identity collision attempt | exact canonical digest tests; SHA-256 collision remains cryptographic residual |
| replay race | serialized count and one record/candidate |
| replay journal corruption | no recovery mutation; owner intervention |
| surviving replay state with missing/replaced key | no reinitialization or recovery mutation; replay unavailable |
| replay/candidate cross-reference injection | strict schema failure in the affected independent domain |
| descending or non-lexical lock request | fail before acquiring the invalid lock |
| retention abuse | remote metadata cannot affect local retention inputs or constants |
| replay metadata spoofing | metadata excluded from replay identity and authority |
| replay-to-authority domain substitution | MAC/domain verification fails |
| replay-to-restore substitution | MAC/domain verification fails |

### 18.3 Accepted residual risks

1. **SHA-256 collision:** collision resistance is assumed.
2. **Whole replay-root rollback:** a same-user attacker who replaces the replay
   key, catalog, manifests, records, and journals with one older internally
   consistent snapshot may reduce detection. There is no portable monotonic
   hardware counter. Authority remains unchanged.
3. **Whole replay-root deletion/new-install ambiguity:** without a platform
   monotonic anchor, complete deletion is indistinguishable from first use.
   Replay evidence may reset; authority remains unchanged.
4. **Post-retention replay:** once a record is compacted after 90 days or due to
   the 4,096-record bound, identical content may be `NEW`. The authenticated
   compaction accumulator preserves bounded audit evidence but not per-identity
   classification.
5. **Remote time authenticity:** `CURRENT`, `STALE`, and `TIME_UNVERIFIED` are
   presentation labels only; Phase 5 does not authenticate remote clocks.
6. **Same-user local attacker:** a process with owner-equivalent access can deny
   replay detection. This is the existing SEC-03 residual and cannot gain
   authority through replay state.

## 19. Package and mutation boundaries

### 19.1 Internal modules

Replay mutation implementations live only under:

```text
noosphere-mcp/continuity/internal/replay/
```

Expected responsibility boundaries:

- `identity.js` — pure canonical replay/recall identity derivation;
- `schema.js` — exact bounded replay schemas;
- `store.js` — owner-only replay records/catalog/manifest;
- `lock.js` — replay locks plus common rank enforcement;
- `journal.js` — replay transaction journal and recovery;
- `operation.js` — the production mutation boundary that invokes recovery;
- `retention.js` — deterministic bounded compaction;
- `observe.js` — one internal observation transaction;
- `classify.js` — pure state/classification mapping;
- `reader.js` — bounded read-only inspection projection.

No replay writer is exported by `package.json`, `trust-store.js`, the MCP
server, lifecycle services, adapter builders, hooks, or relayer packages.

### 19.2 Static boundary rule

The authority and restore writer modules MUST NOT import:

```text
internal/replay/store.js
internal/replay/journal.js
internal/replay/retention.js
internal/replay/observe.js
```

The live `restore stage` orchestration layer MAY call the replay observer and
the existing restore staging service as two bounded internal services. The
replay service itself MUST NOT import or call restore apply, confirmation,
receipt, consumed-marker, approval, revocation, audit, generation, or manifest
writers.

The restore candidate store MAY add an internal candidate-index lock adapter
using a restore-only MAC domain. That adapter accepts only the trusted matching
tuple, participates in the §11 rank hierarchy, and neither accepts nor returns
a replay identity. Existing candidate envelope and state schemas remain
unchanged.

### 19.3 Public readers

Public surfaces MAY expose only the bounded projection:

```text
{
  replayIdentity,
  projectIdentityDigest,
  slot,
  firstSeen,
  lastSeen,
  replayCount,
  state,
  lastClassification
}
```

They MUST NOT expose MACs, replay keys, raw record bytes, journal bytes,
payloads, authority state, restore confirmation material, or mutation handles.

## 20. CLI boundary

Phase 5 defines two optional read-only inspection commands:

```text
noosphere replay status
noosphere replay list [--slot <slot>] [--limit <1..100>]
```

`replay status` reports:

- replay subsystem health;
- canonical project identity digest;
- record count and fixed bounds;
- oldest/newest local observation;
- retention generation and total evicted count;
- incomplete-journal count;
- no payloads.

`replay list` reports the bounded public projection, ordered by
`(lastSeen.observedAt DESC, replayIdentity ASC)`.

There is no replay CLI command for add, remove, clear, reset, reinitialize,
rotate-key, repair, recover, compact, import, export, approve, revoke, restore,
apply, consume, or mutate.
Automatic replay-journal recovery occurs only inside a normal replay operation.
Inspection commands are read-only and fail without changing bytes.

Replay CLI grammar is closed: unknown verbs/options exit with the existing usage
code. Replay failures use the validation/security refusal code assigned during
the implementation plan, but MUST NOT reuse an authority-success meaning.

## 21. Documentation requirements

Phase 5 updates:

- `docs/project-memory/THREAT_MODEL.md`;
- `noosphere-relayer/MEMORY_SECURITY.md`;
- `SECURITY.md`;
- `CHANGELOG.md`;
- `noosphere-relayer/SECURITY-FOLLOWUPS.md`;
- a final `docs/security/SEC-05-PHASE-5-VERIFICATION.md`.

Documentation MUST state:

- replay state is informational and non-authoritative;
- ordinary recall is labeled, not suppressed;
- typed duplicate candidates are suppressed through authenticated restore-store
  lookup, not selected by replay records;
- the exact 4,096-record and 90-day bounds;
- complete replay-root deletion/rollback and post-retention replay residuals;
- deliberate absence of replay-key reinitialization, rotation, reset, repair,
  import, or recovery;
- production mutation paths that automatically recover authenticated incomplete
  replay journals;
- complete replay/candidate identity separation and the global lock hierarchy;
- replay failure does not change authority;
- SEC-05 remains open until exact-head hostile review and tri-platform CI pass.

No document may claim server-authenticated recall, authenticated remote
authorship, human-presence proof, unlimited replay history, or rollback-proof
replay state.

## 22. Verification requirements

All tests exercise production modules, not parallel test-only implementations.
Each test below is mandatory.

### 22.1 Authority independence

- **RPL-T001:** authoritative bytes remain authoritative after replay record,
  journal, manifest, key, project directory, and whole-root deletion.
- **RPL-T002:** untrusted bytes remain untrusted after the same deletions.
- **RPL-T003:** every replay corruption class leaves both authority outcomes
  unchanged.
- **RPL-T004:** no replay classification changes current format-2 generation.
- **RPL-T005:** replay observation cannot approve, revoke, stage, apply, spend,
  receipt, consume, or audit authority.

### 22.2 Identity and schema

- **RPL-T010:** equal canonical project/slot/normalized content produces the
  exact same replay identity across processes and sessions.
- **RPL-T011:** timestamp, ranking, order, action ID, blob ID, agent ID, labels,
  trust claims, and metadata changes do not change replay identity.
- **RPL-T012:** any one-bit canonical normalized content change changes identity.
- **RPL-T013:** project or slot change changes identity.
- **RPL-T014:** replay and recall identity golden vectors match §6 exactly.
- **RPL-T015:** strict schema rejects unknown, omitted, inherited, duplicate,
  noncanonical, oversized, invalid UTF-8, bad timestamp, bad enum, unsafe
  integer, and mismatched derived fields.
- **RPL-T016:** no replay artifact contains recalled payload bytes.
- **RPL-T017:** candidate IDs remain random canonical Phase 4C IDs and are never
  replay identities or deterministic content derivatives.
- **RPL-T018:** replay artifacts contain no candidate ID/path/reference, and
  candidate artifacts contain no replay identity/path/reference.
- **RPL-T019:** candidate matching crosses domains only through the ephemeral
  trusted local `(projectIdentityDigest, slot, candidatePayloadHash)` tuple;
  persisted artifacts have no cross-reference.

### 22.3 State and ordinary recall

- **RPL-T020:** first observation is `NEW`/`SeenOnce`/count 1.
- **RPL-T021:** second ordinary observation is `SEEN`/`Replayed`/count 2.
- **RPL-T022:** later ordinary observations are `REPLAYED` with exact counts.
- **RPL-T023:** ordinary duplicates remain visible in original relative order.
- **RPL-T024:** stale, current, future, missing, and malformed timestamps receive
  exact labels without changing replay identity or authority.
- **RPL-T025:** replay-unavailable ordinary recall remains quoted and visible.
- **RPL-T026:** ranking abuse never fills or changes an authoritative slot.
- **RPL-T027:** crafted recall text cannot infer or trigger approval.

### 22.4 Typed restore

- **RPL-T030:** repeated identical staging returns one active candidate and
  `SUPPRESSED`, not a second candidate.
- **RPL-T031:** different canonical payload or slot creates a distinct candidate.
- **RPL-T032:** consumed identical candidate returns bounded
  `already-consumed`, not a new candidate.
- **RPL-T033:** apply-in-progress identical candidate requires owner
  intervention.
- **RPL-T034:** conflicting or malformed matching candidate state refuses.
- **RPL-T035:** replay record does not contain or select candidate ID.
- **RPL-T036:** deleting or corrupting replay state never changes candidate
  outcome into authority.

### 22.5 Concurrency and crash recovery

- **RPL-T040:** N concurrent first observations produce one record, count N,
  immutable first event, and no lost last event.
- **RPL-T041:** concurrent identical typed staging creates at most one candidate.
- **RPL-T042:** all participating operations enforce ranks 10 → 20 → 30 → 40
  → 50 → 60; descending acquisition and non-lexical same-rank acquisition fail.
- **RPL-T043:** live, malformed, foreign, and unusable replay locks are never
  automatically removed; the same holds for candidate-index locks.
- **RPL-T044:** process death at every journal boundary recovers to exactly one
  committed count.
- **RPL-T045:** recovery is idempotent across repeated processes.
- **RPL-T046:** spliced, corrupt, rolled-back, conflicting, or third-state
  recovery refuses without mutation.
- **RPL-T047:** replay recovery never imports or calls any authority/restore
  writer.
- **RPL-T048:** real child-process invocations of `restore stage`, structured
  ordinary recall, and typed context refresh each refuse a surviving crash lock
  without deleting it and, after explicit owner lock intervention, recover an
  authenticated interrupted journal before observing new content; tests do not
  call recovery directly.
- **RPL-T049:** `replay status` and `replay list` report incomplete journals
  without byte changes, while a subsequent production mutation path performs
  recovery.

### 22.6 Retention

- **RPL-T050:** record count never exceeds 4,096 after a committed operation.
- **RPL-T051:** records older than 90 days are evicted deterministically.
- **RPL-T052:** equal timestamps use replay identity as deterministic tie-break.
- **RPL-T053:** compaction accumulator matches the exact §9.3 construction.
- **RPL-T054:** crash at each retention boundary recovers idempotently.
- **RPL-T055:** remote timestamps/ranking/metadata cannot affect eviction.
- **RPL-T056:** incomplete journals are never automatically evicted.
- **RPL-T057:** retention never changes authority or candidate lifecycle.

### 22.7 Domain and surface boundaries

- **RPL-T060:** ordered substitution of every replay artifact into every
  authority and restore domain fails MAC verification.
- **RPL-T061:** ordered substitution of authority/restore artifacts into every
  replay domain fails.
- **RPL-T062:** package deep imports of replay writers fail.
- **RPL-T063:** packed npm artifacts expose no replay writer.
- **RPL-T064:** MCP tool inventory exposes no replay mutation.
- **RPL-T065:** HTTP/OpenAPI inventory exposes no replay mutation.
- **RPL-T066:** hooks, lifecycle, adapters, and relayer contain no replay writer
  reachability.
- **RPL-T067:** replay CLI exposes only `status` and `list`, and both are
  byte-for-byte read-only.
- **RPL-T068:** authority/restore writer import graph has no replay-writer edge.
- **RPL-T069:** no CLI, MCP, HTTP, package export, hook, lifecycle service,
  adapter, or relayer surface exposes replay-key reset, reinitialization,
  rotation, repair, recovery, import, or export.
- **RPL-T070:** pristine first use creates one key exclusively; key loss or
  replacement with any surviving replay state fails closed without mutation,
  while complete-root deletion has only the documented history-loss residual.

### 22.8 Mutation testing

The mutation harness MUST prove the suite fails when each mutation is applied:

1. add timestamp, ranking, or remote metadata to replay identity input;
2. remove project or slot from replay identity input;
3. treat replay classification as authority;
4. permit replay state to select candidate ID;
5. omit count increment;
6. rewrite first-seen on replay;
7. skip identity locking;
8. reverse lock order;
9. reuse an authority/restore MAC domain;
10. accept noncanonical replay JSON;
11. skip journal before/after digest comparison;
12. retry a journal event by incrementing twice;
13. make ordinary recall suppress duplicates;
14. use remote timestamp for retention;
15. export a replay writer;
16. add a mutating replay CLI verb;
17. let replay failure alter `isSlotAuthoritative`;
18. allow more than 4,096 records or non-deterministic eviction;
19. persist candidate ID/path in replay state or replay identity/path in
    candidate state;
20. derive candidate ID from replay identity or content;
21. bypass the restore candidate-index lock;
22. acquire any lock below the currently held rank or use non-lexical same-rank
    ordering;
23. make recovery reachable only through a direct test helper;
24. let a read-only inspection command recover or otherwise mutate state;
25. recreate or replace a missing replay key when replay artifacts survive;
26. expose a replay-key reset, reinitialize, rotate, repair, import, or recovery
    surface.

Mutation testing SHOULD use repository-owned deterministic source transforms or
dependency injection. It MUST NOT add a production runtime dependency.

## 23. Required test shards

At minimum:

```text
noosphere-mcp/tests/replay-identity.test.js
noosphere-mcp/tests/replay-schema.test.js
noosphere-mcp/tests/replay-store.test.js
noosphere-mcp/tests/replay-state.test.js
noosphere-mcp/tests/replay-concurrency.test.js
noosphere-mcp/tests/replay-crash.test.js
noosphere-mcp/tests/replay-retention.test.js
noosphere-mcp/tests/replay-ordinary-recall.test.js
noosphere-mcp/tests/replay-restore-suppression.test.js
noosphere-mcp/tests/replay-domain-separation.test.js
noosphere-mcp/tests/replay-api-boundary.test.js
noosphere-mcp/tests/replay-cli-boundary.test.js
noosphere-mcp/tests/replay-mutation.test.js
noosphere-mcp/tests/phase5-conformance.test.js
```

Windows crash and concurrency tests MUST be split into bounded files before CI
if measured runtime approaches a per-file timeout. CI timeouts MUST NOT be
increased as a substitute for test decomposition.

## 24. Merge gate

Phase 5 SHALL NOT merge until all of the following pass on the exact proposed
head:

1. focused Phase 5 test shard;
2. full `noosphere-mcp` check;
3. full `@noosphere/secure-fs` suite;
4. replay suite;
5. package/export boundary suite;
6. CLI boundary suite;
7. MCP/HTTP/hook/lifecycle/adapter mutation-surface lockdown;
8. replay-domain substitution matrix;
9. deterministic mutation harness;
10. Linux, macOS, and Windows CI;
11. package dry-run and installed-package boundary verification;
12. diff and clean-tree checks;
13. exact-head independent hostile security review;
14. verification record pinned to the reviewed implementation head;
15. no Critical or Important hostile-review findings;
16. child-process proof that every production replay mutation path refuses
    surviving crash locks, reaches recovery after explicit owner lock
    intervention, and leaves both inspection commands byte-for-byte read-only;
17. replay/candidate artifact scans and schema tests proving complete identity
    separation;
18. global lock-rank conformance and hostile concurrency tests;
19. replay-key-loss and no-reinitialization surface tests.

The Phase 4C Windows result may be explicitly deferred while designing Phase 5,
but Phase 5 cannot merge without a green exact-head Windows gate.

## 25. SEC-05 closure rule

SEC-05 may be marked resolved only when:

- Phases 1–4C remain merged and their invariants pass unchanged;
- all Phase 5 requirements and tests pass;
- exact-head tri-platform CI passes;
- exact-head hostile review finds no Critical or Important issue;
- `SECURITY.md`, threat models, follow-up tracker, changelog, and Phase 5
  verification record all agree;
- the public-readiness statement changes only in the final documentation commit
  reviewed and tested at that exact head.

Until then, SEC-05 remains open and the project remains not public-ready.

## 26. Traceability to original SEC-05 threats

| Threat | Phase 5 control |
|---|---|
| A8 retrieval ranking abuse | local slot selection, content-based identity, replay labels, authority independence |
| A12 approval laundering/non-inference | RPL-I01/I04 plus mutation and boundary tests |
| A13 cross-session replay | persistent replay records, monotonic state/count, ordinary labels, typed suppression |
| replay flooding | fixed record/age/size bounds and deterministic compaction |
| metadata spoofing | metadata excluded from replay identity, retention, and authority |
| crash/race replay loss | global ranked locks, fail-closed owner intervention for surviving crash locks, then production-reachable authenticated exact-state journal recovery |

## 27. Rejected alternatives

### 27.1 Per-response-only deduplication

Rejected because it does not detect replay across sessions and does not close
A13.

### 27.2 Server-issued authenticated recall receipts

Rejected by scope. They would expand the relayer protocol and still would not
make recalled content authoritative.

### 27.3 Reusing authority records or authority manifests

Rejected because replay state must remain observational and must never become a
second route to authority.

### 27.4 Storing payloads in the replay ledger

Rejected because it duplicates untrusted sensitive memory, enlarges the attack
surface, and is unnecessary for deterministic replay identity.

### 27.5 Silent ordinary-recall suppression

Rejected because it hides evidence and lets replay state alter the information
presented to an agent. Ordinary recall is labeled, not removed.

### 27.6 Automatic stale-lock reclamation

Rejected because PID, clock, and pathname races cannot prove safe ownership.
Replay failure is preferable to deleting a live lock.

### 27.7 Persistent replay/candidate cross-references

Rejected because either store could then influence or substitute identity in the
other domain. The live orchestrator passes only a bounded trusted matching tuple;
candidate identity remains random and replay identity remains deterministic.

### 27.8 Replay-key reinitialization or rotation

Consciously omitted from Phase 5. A supported reset or rotation path would need
an additional authenticated owner ceremony, rollback model, migration journal,
and recovery protocol. Phase 5 instead permits key creation only on pristine
first use and fails replay closed when state survives key loss or replacement.
