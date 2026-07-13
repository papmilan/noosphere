# ADR 0002: Reconcile ACP State by Lineage, Not Timestamp Authority

- **Status:** Accepted and implemented
- **Date:** 2026-07-12
- **Decision owners:** Noosphere maintainers
- **Supersedes:** No prior decision
- **Related:** `docs/adr/0001-acp-runtime-project-state.md` and
  `docs/superpowers/specs/2026-07-12-acp-continuity-kernel-design.md`

## Context

ACP v1 stores one canonical Project State Envelope in
`.noosphere/continuity.json`. This gives agents on one checkout a compact,
validated handoff, but it does not let a fresh machine recover the same exact
state. Existing Noosphere memory is unsuitable as an authority mechanism:
semantic recall ranks text by similarity and may omit, reorder, or return a
stale record. Exact state synchronization requires content-addressed retrieval
and deterministic concurrency rules.

The central authority question is what happens when local and remote state
differ. Three obvious rules are unsafe or incomplete:

- Always trust local state: remote restore cannot advance a fresh machine.
- Always trust remote state: a stale or compromised remote record can silently
  replace valid local work.
- Choose the newest timestamp: wall clocks are not a causal ordering and can
  be skewed, forged, or equal.

## Decision

ACP remote synchronization uses immutable snapshots and causal lineage.
Neither location is universally authoritative. Authority is computed from
validated ancestry and repository compatibility.

Each snapshot is addressed by the existing ACP `snapshot_id` and names its
`parent_snapshot_id`. The remote index stores a **set of heads** for each
project rather than one latest pointer. A head is a stored snapshot that is
not the known parent of another stored snapshot.

Reconciliation follows these rules:

1. Identical snapshot IDs mean synchronized state.
2. If the remote head descends from the local snapshot, the remote snapshot is
   a fast-forward candidate.
3. If the local snapshot descends from every remote head, upload local state
   and replace its ancestors in the remote head set.
4. If local and remote heads are concurrent, retain all heads and create an
   explicit ACP divergence conflict. Never choose by timestamp.
5. A candidate with an invalid digest, unsupported schema, foreign project or
   repository identity, or unsafe Git compatibility is quarantined and cannot
   become actionable local state.

Lineage proves causal order, not authorship. Because v1.1 envelopes are not
signed, automatic work may fetch, validate, and stage a candidate but may not
replace local state. Applying a remote fast-forward or empty-local restore
requires an explicit user command and a short-lived confirmation bound to the
full observation that produced the candidate. A future signed-writer ADR may
permit automatic application without changing reconciliation semantics.

Confirmation binds the remote snapshot ID, current local snapshot ID or null,
remote head-set digest, repository observation digest, sync protocol version,
reconciliation policy version, expiry, and the stable relayer index identity.
Apply re-reads local state, re-observes Git, re-fetches and revalidates
canonical remote bytes, and reruns reconciliation. Any mismatch or expiry
returns `confirmation-stale` without a local write.

Git status `advanced` is stale project state relative to the checkout. It is
historical and non-actionable by default. An explicit `--allow-stale-advanced`
override may activate it only through the same confirmation protocol;
repository-dependent assertions remain trust-downgraded and cannot silently
become authoritative next actions.

## Exact Storage Boundary

Remote ACP storage is separate from semantic memory. It stores canonical
WireEnvelope bytes and exact lineage metadata. Implementations expose:

```text
putSnapshot(projectId, canonicalEnvelope) -> SnapshotReceipt
getSnapshot(projectId, snapshotId) -> canonicalEnvelope | not-found
getHeads(projectId) -> HeadRecord[]
compareAndSetHeads(projectId, expectedHeadSetDigest, nextHeads) -> result
```

The interface is storage-neutral. No field or protocol operation depends on
Walrus, SQLite, S3, Postgres, or Noosphere.

Walrus Memory is the first encrypted remote byte backend. The Noosphere
relayer maintains the exact snapshot-to-blob and project-head index needed for
deterministic lookup. Semantic search is never used to select a head.

## Head-Set Semantics

Head sets are unordered mathematically and serialized in lexicographic
snapshot-ID order. Their digest is the SHA-256 digest of the RFC 8785 canonical
UTF-8 JSON array. The empty set is canonical bytes `[]` and has digest
`sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`.
Clients send the head-set digest they observed. A compare-and-set operation
either commits against that exact digest or returns the current set without
mutation.

Uploading a snapshot is idempotent:

- the same project, snapshot ID, and identical canonical bytes return the
  existing receipt even after that completed submission advances heads;
- the same snapshot ID with different bytes is an integrity violation;
- a new child removes its stored parent from the head set and adds itself;
- a new concurrent snapshot adds another head;
- a missing parent does not reject storage, but marks lineage incomplete and
  keeps the snapshot non-actionable until its ancestry is available.

After every insertion and on restart recovery, the index recomputes head and
completeness state from all indexed snapshot-parent edges in one atomic update.
This makes an already-stored child complete when its missing parent arrives and
removes that parent from the head set. Server metadata is discovery data only:
a client must fetch and validate every canonical envelope on an ancestry path
before using that path for an authority decision.

## Local and Remote Responsibilities

The local checkout remains responsible for:

- validating the envelope and repository compatibility;
- rendering `continuity.md`;
- deciding whether a remote head is a safe fast-forward;
- creating explicit divergence conflicts;
- preserving a quarantined candidate for inspection;
- never exposing remote content as instructions before validation.

The remote service remains responsible for:

- validating canonical bytes and content identity;
- durable snapshot storage;
- exact lookup by project and snapshot ID;
- atomic head-set updates within its supported deployment model;
- idempotent receipts and retry safety;
- never merging or interpreting Project State.

## Failure and Availability Rules

Local handoff success does not depend on remote availability. Before changing
local state, the coordinator durably reserves the exact canonical envelope in
its bounded upload queue; a full queue applies backpressure without changing
local state. Reservations are not uploadable until the canonical local write
commits and an exact-byte transition marks them ready. Restart recovery removes
an unmatched reservation or promotes one matching the committed local state.
Remote upload may then retry without holding the metadata lock.

A remote head becomes visible only after its snapshot bytes are durable. A
failed upload cannot publish a dangling head. A failed head update after a
successful byte upload leaves an unreferenced immutable snapshot that may be
adopted idempotently on retry.

Pull failures do not delete or downgrade valid local state. Corrupt or foreign
remote snapshots are quarantined and reported. Network errors produce a
deferred-sync status, not a fabricated synchronized result.

## Deployment and Durability Boundary

Cross-machine exact synchronization exists only when every participating
client uses the same reachable relayer and that relayer's exact index is on a
shared durable deployment. Sharing Walrus credentials alone is insufficient:
the index contains the exact snapshot-to-blob mapping, lineage, completeness,
and head set.

Deployments advertise one of three capability modes:

- `local-only`: bytes and index are local; no cross-machine claim;
- `shared-relayer`: exact bytes and durable index are served by the same shared
  relayer deployment; cross-machine exact synchronization is available;
- `walrus-backed/relayer-indexed`: bytes have a Walrus replica but exact lookup
  and heads still depend on the same durable relayer index. Cross-machine sync
  is available only through that relayer, not from Walrus credentials alone.

Each durable index carries a stable non-secret identity so clients can verify
that they participate in the same synchronization topology.

Exact-byte durability means acknowledged canonical bytes can be read back
byte-for-byte. Index durability means acknowledged mappings, parent edges,
receipts, completeness, and heads survive relayer restart. Cross-machine
recoverability requires both forms of durability to remain reachable through
the same configured relayer. Loss of either can leave durable but undiscoverable
bytes or an index pointing at unavailable bytes; neither state may be reported
as recoverable.

## Security and Trust

- Every downloaded snapshot passes size, JSON, schema, digest, domain
  invariant, project identity, repository identity, and Git compatibility
  validation before use.
- Remote bytes are untrusted even when transport authentication succeeds.
- Existing unsigned envelopes remain capped at their current trust level.
- A bearer token authorizes reads and writes but does not identify the human or
  agent that authored an envelope; unsigned remote candidates require explicit
  local confirmation before application.
- Server authentication authorizes storage access but does not prove snapshot
  correctness.
- The envelope limit is 1,048,576 bytes, matching the ACP handoff limit and
  remaining below the relayer's 2 MiB JSON request limit.
- Default per-project limits are 10,000 indexed snapshots, 32 concurrent heads,
  200 validated ancestry envelopes per reconciliation, and 268,435,456 indexed
  canonical bytes. Limits are checked before publishing a head; exceeding one
  produces an explicit quota or incomplete-lineage result, never truncation.
- Expired envelopes may remain immutable history but can never become
  actionable, including through an override.
- Quarantine files are generated local state, excluded from Git, and never
  loaded automatically. Their basename is derived only from a validated
  lowercase `sha256:<64 hex>` snapshot ID, encoded as `sha256-<64 hex>.json`;
  invalid IDs use a locally generated digest of the received bytes.
- A future signature ADR may raise origin trust without changing lineage
  reconciliation.

## Determinism

Given the same validated local snapshot, remote snapshot graph, repository
observation, clock, and policy, reconciliation returns the same ordered
actions, conflicts, quarantine decisions, and head-set digest.

The algorithm does not use response order, semantic distance, wall-clock
recency, locale, random selection, or model judgment. Snapshot and head arrays
are sorted by normalized snapshot ID before comparison or serialization.

## Consequences

### Positive

- Cross-machine recovery through the same durable relayer index can use exact
  state rather than reconstructed prose.
- Concurrent agents cannot silently overwrite one another.
- Retries are naturally idempotent through content addressing.
- Storage backends remain replaceable.
- Remote compromise or staleness cannot automatically displace valid local
  state without passing ACP and Git validation.

### Costs

- The remote service must maintain exact lineage metadata in addition to blob
  storage.
- Divergence is surfaced rather than hidden, so some sync operations require
  explicit resolution.
- ACP schema 1.0 has one parent per envelope. It can preserve concurrent heads
  but cannot prove that one descendant causally incorporates two heads. Remote
  head collapse therefore waits for a future multi-parent schema rather than
  encoding a lossy pseudo-merge.
- Multi-instance atomic head updates require a transactional store; the first
  file-backed relayer implementation supports one writer process only.
- Rebuilding a lost relayer index from Walrus is not guaranteed until the
  Walrus backend exposes exact enumeration or an independently durable
  manifest. V1.1 reports client-machine recoverability only when the configured
  shared relayer exposes healthy exact bytes and its durable index; it does not
  guarantee recovery from total loss of both the relayer index and clients.

## Rejected Alternatives

### Last-write-wins by timestamp

Rejected because timestamps do not express causality and permit silent data
loss.

### Semantic recall of the newest envelope

Rejected because semantic ranking is neither complete nor deterministic.

### One mutable remote state object

Rejected because overwrites erase concurrent branches and weaken auditability.

### Server-side semantic merge

Rejected because the storage service must not invent Project State decisions
or resolve conflicts without project evidence.
