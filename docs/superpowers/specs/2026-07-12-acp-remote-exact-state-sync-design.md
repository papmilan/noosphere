# ACP Remote Exact-State Synchronization Design

**Date:** 2026-07-12
**Status:** Revised specification awaiting user review
**Normative decision:** `docs/adr/0002-acp-remote-lineage-authority.md`

## Purpose

ACP v1 gives one checkout a validated Project State Envelope and compact
continuity kernel. V1.1 makes the exact canonical envelope durable through a
configured deployment and, when all clients use the same durable relayer
index, recoverable across machines and agent products without treating
semantic memory as authoritative state.

The feature synchronizes immutable canonical envelopes and their lineage. It
does not synchronize private reasoning, raw chat, complete repositories, or
model-provider sessions. It never chooses a winner by timestamp and never
silently merges concurrent project decisions.

## Scope

This is one vertical product slice:

- exact snapshot storage and lookup in the relayer;
- an atomic project head-set index;
- file-backed and Walrus-backed snapshot bytes behind one interface;
- MCP/CLI client synchronization;
- lineage-based push, pull, fast-forward, divergence, and quarantine;
- durable upload retries and idempotency;
- restore of `continuity.json` and regenerated `continuity.md` on another
  machine using the same durable relayer index;
- HTTP discovery and OpenAPI documentation;
- focused local, relayer, restart, and clean-machine tests.

Separate future work includes:

- cryptographic agent identities and signed envelopes;
- distributed multi-instance head consensus;
- exact Walrus index reconstruction after simultaneous client and relayer
  index loss;
- automatic semantic extraction from conversations;
- public ACP certification and non-JavaScript reference implementations.

## Approaches Considered

### Local state always wins

Remote storage would be backup-only. This avoids accidental pull overwrites,
but a fresh machine could not safely resume from newer remote state without a
manual authority override.

### Newest valid remote timestamp wins

This is operationally simple and appears seamless. It is rejected because
clock order is not causal order and would silently discard concurrent work.

### Immutable snapshots with lineage reconciliation

Each envelope is content-addressed, remote storage retains every immutable
snapshot, and the project has a set of current heads. Local and remote state
fast-forward only when ancestry proves the relationship. Divergence is
preserved as an explicit conflict.

**Decision:** Use immutable snapshots and lineage reconciliation.

## User Experience

### Normal handoff

1. An agent runs `noosphere handoff --file update.json` or `--stdin`.
2. Noosphere validates, merges, and atomically writes local state.
3. If remote synchronization is enabled, the canonical envelope is enqueued
   for exact upload.
4. The command succeeds locally even when the network is unavailable and
   reports `remote: queued` when replication is pending.
5. The background manager retries pending uploads and updates the local sync
   receipt when the snapshot becomes a remote head.

### New machine

1. The user clones the repository and runs `noosphere activate` or
   `noosphere state sync`.
2. Noosphere reads project identity from configuration and requests exact
   remote heads.
3. Each candidate is downloaded by snapshot ID and fully validated.
4. If exactly one candidate is a safe fast-forward with `exact` or
   `compatible` Git status, Noosphere emits a short-lived confirmation object
   bound to the full local, remote, repository, protocol, and policy
   observation.
5. On confirmation, Noosphere repeats the entire observation and validation.
   Only an unchanged result is written to `continuity.json`; `continuity.md`
   is regenerated locally.
6. Divergent, incomplete, expired, foreign, or invalid candidates are not
   applied. `advanced` candidates are historical-only unless the user also
   supplies `--allow-stale-advanced`.

### Explicit commands

```text
noosphere state sync          Reconcile local and remote heads safely
noosphere state push          Upload local snapshot without pulling
noosphere state pull          Fetch and evaluate remote candidates
noosphere state history       List exact known lineage and head status
noosphere state quarantine    List rejected remote candidates
```

`sync`, `push`, and `pull` support `--json`. `pull` never means “force.” ACP
schema 1.0 preserves concurrent heads until a multi-parent schema can express
an honest causal merge; v1.1 does not provide a force-collapse operation.

## Architecture

```text
Agent update
  -> local ACP validation and merge
  -> atomic continuity.json + continuity.md
  -> durable replication queue
  -> relayer exact-state API
  -> canonical snapshot backend (file or Walrus)
  -> transactional head-set index

New agent
  -> exact head list
  -> exact snapshot fetch by ID
  -> ACP + repository validation
  -> lineage reconciliation
  -> confirmation-bound candidate OR historical/divergence/quarantine
```

Semantic remember/recall remains a parallel subsystem. It may help an agent
discover relevant history, but it does not participate in exact state head
selection.

## Deployment Topology and Capability Model

Cross-machine synchronization requires all participating clients to use the
same reachable durable relayer index. Sharing a project ID, Walrus account, or
Walrus credentials without sharing the relayer index is insufficient because
Walrus semantic storage does not provide the exact snapshot-to-blob map,
lineage graph, completeness state, or head-set compare-and-set record.

The relayer advertises exactly one deployment mode:

| Mode | Exact bytes | Exact index | Cross-machine claim |
|---|---|---|---|
| `local-only` | Local relayer storage | Local relayer index | None |
| `shared-relayer` | Durable storage reachable by the shared relayer | Durable shared relayer index | Yes, through that relayer |
| `walrus-backed/relayer-indexed` | Walrus replica plus any required relayer exact copy | Durable shared relayer index | Yes, only through that same relayer |

`GET /v1/acp/capabilities` and head responses report:

```json
{
  "deployment_mode": "walrus-backed/relayer-indexed",
  "exact_bytes_durable": true,
  "index_durable": true,
  "cross_machine_recoverable": true,
  "relayer_index_id": "sha256:...",
  "sync_protocol_version": "noosphere.acp-sync/1",
  "reconciliation_policy_version": "noosphere.acp-reconcile/1"
}
```

`cross_machine_recoverable` may be true only when exact byte reads and the
durable index are both available to other clients through the configured
relayer. `relayer_index_id` is a stable, non-secret identifier generated with
and persisted inside that index; participating clients can verify that they
are using the same index. Credentials alone never imply the capability.

## Relayer Components

### ExactStateService

`noosphere-relayer/exact-state.js` owns validation, idempotency, and head-set
transitions. It depends only on the snapshot backend and head index interfaces.

```js
export class ExactStateService {
  putSnapshot(projectId, canonicalEnvelope, expectedHeadsDigest)
  getSnapshot(projectId, snapshotId)
  getHeads(projectId)
  getHistory(projectId, options)
}
```

It verifies canonical encoding and digest using a small relayer-side ACP wire
validator shared as a packaged protocol module, not by importing CLI code
through relative repository paths.

### SnapshotBackend

```js
export class SnapshotBackend {
  async put(projectId, snapshotId, canonicalBytes) {}
  async get(projectId, snapshotId) {}
  async health() {}
}
```

Required behavior:

- `put` is content-idempotent;
- the same ID with different bytes is an integrity error;
- `get` returns the exact bytes stored or `not-found`;
- successful `put` means bytes are durable for that backend;
- backends never interpret goals, plans, or conflicts.

### FileSnapshotBackend

The reference backend writes mode-0600 canonical snapshots under a configured
relayer state directory, grouped by a hash of project ID and snapshot ID. It
uses temporary files and atomic rename. It is suitable for tests, local-only
operation, protocol reference behavior, and a shared relayer only when that
directory is durable and served by the same shared deployment.

### WalrusSnapshotBackend

The first remote backend stores a prefixed canonical envelope through the
existing authenticated and encrypted Walrus Memory adapter. It records the
returned blob ID in the exact index. Retrieval uses the recorded exact blob
mapping; semantic queries are not allowed in `get` or `getHeads`.

If the installed MemWal SDK cannot fetch exact bytes by blob ID, V1.1 may store
an encrypted snapshot copy in the relayer's durable snapshot directory while
uploading the same canonical bytes to Walrus for remote durability. The
product must report this as `walrus-backed / relayer-indexed`, not claim that
the Walrus blob alone is sufficient for exact restore. Shipping must not
fabricate an exact-read capability the SDK does not provide.

### Durability dimensions

The service reports three distinct facts:

- **exact-byte durability:** an acknowledged snapshot can be fetched later as
  the same canonical bytes;
- **index durability:** acknowledged blob mappings, parent edges, completeness,
  receipts, and heads survive relayer restart;
- **cross-machine recoverability:** other clients can reach both durable bytes
  and that exact durable index through the same relayer deployment.

Walrus replication may improve byte durability without improving index
durability. A durable index without readable bytes is also insufficient. The
service must degrade its capability report when either health check fails and
must not acknowledge a new published head as cross-machine recoverable.

### HeadIndex

```js
export class HeadIndex {
  async read(projectId) {}
  async compareAndSet(projectId, expectedDigest, nextRecord) {}
  async recordSnapshot(projectId, snapshotMetadata) {}
}
```

The first implementation extends the relayer durable store with a versioned
`exact_state` section containing:

```json
{
  "projects": {
    "project-id": {
      "heads": ["sha256:..."],
      "heads_digest": "sha256:...",
      "snapshots": {
        "sha256:...": {
          "parent_snapshot_id": null,
          "blob_id": "backend-receipt",
          "stored_at": "2026-07-12T00:00:00.000Z",
          "bytes": 12345
        }
      }
    }
  }
}
```

Head arrays are lexicographically sorted. `stored_at` is operational metadata
only and never affects authority or ordering.

The head-set digest is SHA-256 over the RFC 8785 canonical UTF-8 JSON encoding
of the sorted array. The empty head set is the two bytes `[]` and therefore
has digest
`sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`.

The file index supports one relayer writer process. A later Postgres index can
implement the same compare-and-set contract for multiple instances.

## Resource Limits

V1.1 applies these deterministic per-project defaults:

| Resource | Limit | Result when exceeded |
|---|---:|---|
| One canonical snapshot | 1,048,576 bytes | `snapshot-too-large` / HTTP 413 |
| Indexed snapshots | 10,000 | `snapshot-index-limit` / HTTP 507 |
| Concurrent heads | 32 | `head-limit` / HTTP 409; bytes may remain unreferenced |
| Validated ancestry per reconciliation | 200 envelopes | `incomplete-lineage`; never apply |
| Total indexed canonical bytes | 268,435,456 bytes | `project-byte-limit` / HTTP 507 |

Limits are evaluated before head publication. There is no silent eviction,
truncation, timestamp-based pruning, or partial ancestry authority. Stored
expired snapshots remain counted until a separately authorized retention
operation exists; v1.1 does not invent automatic history deletion.
`Total indexed canonical bytes` is the sum of canonical byte lengths for every
snapshot record currently present in the project's exact index.

## HTTP API

All routes use existing bearer authentication, exact CORS, rate limiting,
security headers, and project ID validation.

### Upload snapshot

`POST /v1/projects/:project_id/acp/snapshots`

Request:

```json
{
  "expected_heads_digest": "sha256:...",
  "envelope": {}
}
```

Responses:

- `201`: new snapshot stored and head set updated;
- `200`: identical snapshot already exists;
- `202`: bytes queued for remote durability; head is not yet published;
- `409`: expected head digest is stale; returns current heads;
- `413`: canonical envelope exceeds 1,048,576 bytes;
- `422`: invalid ACP envelope, digest, project binding, or parent metadata;
- `507`: per-project snapshot-count or indexed-byte quota is exhausted.

The idempotency key is `acp-snapshot:<snapshot_id>`. A completed receipt may be
replayed without uploading or changing heads again.

### List heads

`GET /v1/projects/:project_id/acp/heads`

Returns the sorted head records, head-set digest, completeness status, and
capability object. It never returns semantic recall results.

### Fetch exact snapshot

`GET /v1/projects/:project_id/acp/snapshots/:snapshot_id`

Returns the canonical envelope with an ETag equal to the snapshot ID. A
snapshot is returned only when its stored bytes revalidate to the requested
ID.

### List bounded lineage

`GET /v1/projects/:project_id/acp/history?head=<id>&limit=<1..200>`

Returns untrusted discovery metadata only: ID, parent, byte size, storage
receipt, and whether the parent is locally indexed. Canonical bytes require
the exact snapshot route. A client must fetch and validate every envelope on a
lineage path before using that path in reconciliation.

## Client Components

### RemoteStateClient

`noosphere-mcp/continuity/acp/remote-client.js` implements the HTTP contract,
uses the existing relayer token, applies read/write timeouts, bounds response
size, and returns typed transport results. It does not decide reconciliation.

### Reconciler

`noosphere-mcp/continuity/acp/reconcile.js` is pure. Inputs are:

- validated local ProjectState or null;
- validated remote states and lineage metadata;
- observed repository;
- explicit clock and policy.

Output is an ordered action plan:

```text
already-synced
push-local
fast-forward-local
remote-only-restore
diverged
incomplete-lineage
quarantine
deferred
historical-advanced
```

The reconciler does not perform I/O. Its tests use complete graph fixtures.

### Sync coordinator

`noosphere-mcp/continuity/acp/sync.js` performs remote calls, validates bytes,
invokes the reconciler, creates confirmation objects, performs apply-time
revalidation, writes confirmed local fast-forwards through `store.js`, and
records generated sync metadata.

`.noosphere/continuity-sync.json` contains operational state only:

```json
{
  "version": 1,
  "remote_heads": ["sha256:..."],
  "remote_heads_digest": "sha256:...",
  "last_uploaded_snapshot_id": "sha256:...",
  "last_sync_at": "2026-07-12T00:00:00.000Z",
  "status": "synchronized",
  "pending": [],
  "confirmations": {
    "sha256:...": {
      "remote_snapshot_id": "sha256:...",
      "expires_at": "2026-07-12T18:40:00.000Z"
    }
  }
}
```

It is excluded from Git, written owner-only with atomic replacement, and has no
authority over `continuity.json`. The abbreviated confirmation above is only
illustrative; the stored value is the complete canonical confirmation object
defined below.

### Confirmation object and apply transaction

A candidate confirmation is an operational object, not Project State:

```json
{
  "remote_snapshot_id": "sha256:...",
  "local_snapshot_id": null,
  "remote_heads_digest": "sha256:...",
  "repository_observation_digest": "sha256:...",
  "relayer_index_id": "sha256:...",
  "sync_protocol_version": "noosphere.acp-sync/1",
  "reconciliation_policy_version": "noosphere.acp-reconcile/1",
  "action": "remote-only-restore",
  "allow_stale_advanced": false,
  "expires_at": "2026-07-12T18:40:00.000Z",
  "confirmation_id": "sha256:..."
}
```

`local_snapshot_id` is explicitly null when no local envelope exists. The
repository observation digest is SHA-256 over the RFC 8785 canonical encoding
of the complete captured observation: root identity, HEAD, branch, dirty flag,
workspace fingerprint, and sorted bounded ancestor list. `confirmation_id` is
the SHA-256 digest of the canonical object excluding `confirmation_id`.
Confirmations expire after at most five minutes and never outlive the remote
envelope's own expiry.

The coordinator stores at most 16 complete confirmation objects in the
owner-only `confirmations` map, keyed by `confirmation_id`. It removes expired
entries before insertion and evicts no unexpired entry; when all 16 are live it
returns `confirmation-cache-full`. `--confirm-remote <confirmation_id>` loads
the exact object from this cache. Every apply attempt deletes its entry before
validation, whether it succeeds or fails, so confirmations are single-use and
cannot be replayed. A missing entry returns `confirmation-missing` and never
triggers a remote apply.

Before any local write, apply executes one transaction-like check:

1. validate the confirmation schema and `confirmation_id`, then reject an
   expired confirmation or expired remote envelope;
2. re-read and fully validate current local `continuity.json`;
3. request current remote heads and require the same head-set digest;
4. re-fetch exact remote canonical bytes by snapshot ID and revalidate size,
   JSON, schema, canonical digest, project binding, expiry, and ETag;
5. re-observe Git and recompute the full repository observation digest;
6. require the same relayer index ID and supported sync and reconciliation
   policy versions;
7. rerun pure reconciliation with the same override policy and require the
   same candidate action and remote snapshot ID;
8. immediately before writing, repeat the local snapshot read, remote head-set
   read, Git observation digest, exact remote-byte fetch/validation, and
   capability read; require the relayer index identity and sync/policy versions
   as well as all other values to equal the values just reconciled;
9. atomically compare the expected local snapshot ID and write the canonical
   local pair through `store.js`.

Any mismatch, expiry, validation failure, or changed result returns
`confirmation-stale` and leaves the local pair unchanged. This includes a
change from explicit-null local state to any local snapshot.

## Reconciliation Algorithm

1. Normalize and sort remote head IDs.
2. Validate every downloaded envelope and verify response ID/ETag.
3. Reject candidates whose `repository.project_id` or `root_identity` does not
   match the local project.
4. Use history metadata only to discover candidate paths, then fetch and
   validate every canonical envelope on any path that could affect the result.
   Build the authority graph exclusively from those validated envelopes.
5. Compute reachability by snapshot ID, never by timestamp.
6. If local ID is a remote head, return `already-synced`.
7. Reject expired envelopes from every actionable result. They may appear only
   in history or quarantine diagnostics.
8. If local is null and exactly one complete, Git-actionable remote head
   exists, return `remote-only-restore` as a confirmation-required candidate.
9. If exactly one remote head descends from local and is Git-actionable,
   return `fast-forward-local` as a confirmation-required candidate.
10. If the only lineage candidate is `advanced`, return `historical-advanced`
    unless the explicit policy allows a stale advanced candidate.
11. If local descends from every remote head, return `push-local`.
12. If ancestry is missing or exceeds 200 validated envelopes, return
    `incomplete-lineage`; fetch only up to the bounded history limit before
    making another decision.
13. Otherwise return `diverged`, preserve every head, and construct an ACP
    synchronization conflict referencing the head IDs.

The algorithm is deterministic for the same graph and inputs.

### Git actionability predicate

The coordinator uses the existing pure `classifyCompatibility` contract with
one captured repository observation: root identity, HEAD, branch, dirty flag,
workspace fingerprint, and a bounded list of HEAD ancestors. `exact` and
`compatible` are actionable after confirmation. `advanced` is historical-only
by default; it cannot become active Project State or provide authoritative next
actions. `diverged`, `foreign`, and `unknown` are not actionable. A detached
HEAD is represented by a null branch and is handled by the same comparison. A
missing Git repository or missing root commit is `unknown`. Dirty state is not
ignored: at equal HEAD, differences in branch, dirty flag, or workspace
fingerprint downgrade `exact` to `compatible`; they do not authorize
source-file mutation. A sync protocol or policy version unsupported by the
client is non-actionable. The observation is captured once per reconciliation
run so repository changes cannot alter a decision halfway through evaluation.

`--allow-stale-advanced` changes the reconciliation policy for one explicitly
confirmed application. The confirmation binds that flag and policy version.
Even then, all assertions whose correctness depends on repository files, Git
state, test results, generated artifacts, or line references receive the ACP
compatibility trust downgrade and are excluded from authoritative next-action
selection until a new handoff revalidates them against the current checkout.
Expired state remains non-actionable and cannot be overridden.

## Divergence and Resolution

Divergence never overwrites `continuity.json`. The coordinator writes a
generated conflict record to `.noosphere/continuity-sync.json` and prints each
head with repository and provenance information. Remote snapshots may be
stored in `.noosphere/quarantine/` for inspection.

Quarantine paths never use raw project IDs, remote IDs, headers, or user text.
A validated lowercase snapshot ID `sha256:<64 hex>` maps to
`sha256-<64 hex>.json`; if no valid ID exists, the basename uses a locally
computed SHA-256 digest of the received bytes. Creation uses an exclusive,
owner-only file beneath the fixed quarantine directory and rejects symlinks.

ACP v1 envelopes have one parent. A user may select one head as the active
local lineage and create descendants from it, while recording the competing
head as evidence, but that does not make the other remote head an ancestor.
The remote service therefore retains both heads. Collapsing them into one
authoritative head requires a future multi-parent envelope schema; v1.1 must
not pretend an evidence reference is a causal merge.

## Automatic Behavior

- `handoff` always commits local state first.
- Successful local handoff enqueues remote upload when sync is enabled.
- `activate` performs a bounded head check and may stage one safe candidate,
  but unsigned remote state is never applied automatically.
- `state sync` and `state pull` require explicit confirmation before applying
  a remote fast-forward or empty-local restore. `--json` reports the full
  confirmation object and exits without applying. A later invocation supplies
  `--confirm-remote <confirmation_id>`; the coordinator then performs the full
  apply-time revalidation above. A snapshot ID alone is never confirmation.
- Automatic sync never resolves divergence, changes branches, modifies source
  files, or runs Git commands that mutate the checkout.
- Offline operation remains fully functional and visibly reports pending sync.
- `NOOSPHERE_ACP_SYNC=false` disables automatic remote work without deleting
  local or remote state.

## Privacy and Security

- Remote exact state is opt-in for existing projects during V1.1 rollout.
- New projects enable it only when a remote memory backend and authentication
  are configured; local-only setups remain local.
- Upload uses canonical envelope bytes only. `continuity.md`, journal, master
  prompt, raw source, diffs, and semantic context are not bundled.
- The relayer verifies ACP schema and content digest independently.
- Clients treat all remote bytes as untrusted and validate them again.
- Prompt-like text inside an envelope remains data and cannot alter adapter
  instructions.
- Quarantined state never enters the startup kernel.
- Expired envelopes never enter the startup kernel or any actionable result.
- Logs record project ID, snapshot ID, byte size, disposition, and error code;
  they do not log envelope contents or access tokens.

## Queue and Crash Consistency

The existing durable queue gains an ACP snapshot job type. Pending jobs retain
canonical bytes in the owner-only runtime state until the backend confirms
durability. After success:

1. record exact snapshot metadata;
2. atomically compare-and-set the head set;
3. store the idempotency receipt;
4. remove pending plaintext bytes.

Restart recovery repeats the same steps. Content addressing prevents duplicate
blobs from becoming different logical snapshots. If head compare-and-set
fails, the snapshot stays stored and the client receives `409` with current
heads; a retry recomputes the intended head set.

Whenever a snapshot is recorded, and again during restart recovery, the
relayer recomputes completeness and heads from every indexed parent edge for
that project, then atomically writes the new project index record. Therefore a
child uploaded before its parent becomes complete when the parent arrives, and
the newly arrived parent is not incorrectly published as a second head.

## Migration and Compatibility

- Existing ACP projects start with local-only state and no remote head.
- The first `state push` uploads the current valid envelope as the initial
  remote head.
- Existing semantic memories are not converted into exact state because their
  content and ordering cannot prove a canonical snapshot.
- Existing restore of baseline/master-prompt/follow-ups remains unchanged.
- `noosphere restore` invokes exact ACP discovery after typed intent
  restoration. It reports a confirmation object but does not apply unsigned
  remote state without the same explicit confirmation flow. Failure to find
  exact state does not erase restored intent files.
- Older clients ignore new routes and sync metadata.
- The ACP envelope schema stays at `1.0.0`; the remote synchronization
  protocol is independently versioned as `noosphere.acp-sync/1`.

## Error Handling

- Network unavailable: retain local state and mark `deferred`.
- Authentication failure: fail remote operation; do not retry indefinitely.
- Rate limit: preserve queue job and honor server retry hints.
- Invalid local envelope: refuse upload and instruct `state validate`.
- Invalid remote envelope: quarantine and report `remote-invalid`.
- Foreign repository/project: quarantine and report `foreign-state`.
- Expired remote envelope: retain as history or quarantine and report
  `remote-expired`; never offer confirmation.
- Confirmation observation, versions, expiry, local snapshot, remote bytes, or
  reconciliation result changed: return `confirmation-stale` without writing.
- Confirmation ID is absent, consumed, or evicted after expiry: return
  `confirmation-missing`; a full sync is required to issue a new observation.
- Advanced repository compatibility: report `historical-advanced`; require a
  newly bound confirmation plus `--allow-stale-advanced` to activate with
  downgraded repository-dependent assertions.
- Stale head-set digest: fetch current heads and rerun pure reconciliation.
- Missing parent: fetch bounded history; otherwise report incomplete lineage.
- Snapshot count, head count, ancestry, or indexed-byte limit: return the
  specific bounded error and do not truncate or invent authority.
- Backend stored bytes but head update failed: leave immutable bytes
  unreferenced and retry head update idempotently.
- Local write fails after remote fetch: keep current local pair unchanged.
- Multiple remote heads: report divergence; never choose one automatically.

## Testing

### Pure reconciler

- identical IDs;
- local ancestor of one remote head;
- local descendant of all remote heads;
- concurrent local/remote heads;
- multiple remote heads;
- missing parent;
- ancestry metadata that disagrees with fetched canonical envelopes;
- foreign project/repository;
- invalid and expired state;
- `advanced` historical-only default and explicit downgraded override;
- stable ordering independent of response order and timestamps.

### Relayer

- content-idempotent upload;
- same ID/different bytes rejection;
- exact retrieval byte equality;
- sorted head set and stable digest;
- exact empty-head digest fixture;
- parent replacement and concurrent head addition;
- stale compare-and-set conflict;
- queued upload does not publish head early;
- restart recovery publishes head after durable bytes;
- child-before-parent upload becomes complete and yields the correct head,
  including after restart;
- completed receipt avoids re-upload;
- request size, auth, rate limit, CORS, and log redaction;
- snapshot-count, concurrent-head, ancestry, and indexed-byte boundaries;
- capability reports distinguish byte durability, index durability, and
  cross-machine recoverability;
- file and Walrus-backed adapter contract tests.

### CLI

- local handoff succeeds while remote is offline;
- pending state survives restart;
- push and exact pull round trip;
- confirmed safe fast-forward regeneration of kernel;
- confirmation becomes stale when any bound observation changes;
- confirmations survive a CLI process boundary, remain owner-only, are
  single-use, expire, and obey the 16-entry bound;
- remote bytes are fetched and validated again immediately before apply;
- expired candidates are never actionable, including with overrides;
- path-hostile snapshot IDs cannot escape quarantine;
- advanced state is historical-only unless explicitly overridden, and its
  repository-dependent assertions are trust-downgraded;
- automatic activation never applies unsigned remote state;
- fresh-machine restore;
- divergence preserves local state;
- invalid/foreign remote state is quarantined;
- `--json` results are stable and contain no envelope content unless explicitly
  requested by `state --json`;
- disabling sync performs no network calls.

### Clean-machine acceptance

1. Machine A creates and pushes a unique ACP snapshot through a relayer that
   reports durable bytes, durable index, and cross-machine recoverability.
2. Machine B uses that same relayer deployment, clones the same Git revision,
   and starts with no `.noosphere` state.
3. Machine B initializes project identity and performs exact sync, which
   reports the unsigned candidate without applying it.
4. Machine B applies that exact unchanged observation with
   `--confirm-remote <confirmation_id>`.
5. Restored canonical JSON has the same snapshot ID and canonical digest.
6. Locally rendered kernel matches Machine A byte-for-byte for the same Git
   observation and policy.
7. Semantic recall is disabled during this test to prove exact-state authority.

## Success Criteria

- Exact state survives loss of a client checkout and is restorable through the
  same configured durable relayer index used by the publishing client.
- The product makes no cross-machine exact-sync claim for `local-only` mode or
  from shared Walrus credentials without the shared relayer index.
- No successful sync uses semantic recall to select state.
- No concurrent head is silently discarded.
- Offline handoffs remain successful and upload later.
- Identical upload retries produce one logical snapshot and one head result.
- Invalid or foreign remote state never replaces local state.
- Expired state and stale confirmations never replace local state.
- Focused and full MCP/relayer suites pass on macOS, Linux, and Windows.
- A clean-machine round trip restores byte-identical canonical state.

## Rollout

1. Ship exact file backend, head index, API, and pure client reconciler behind
   `NOOSPHERE_ACP_REMOTE_SYNC`.
2. Validate local two-machine simulation and restart recovery.
3. Enable Walrus-backed snapshot upload with honest capability reporting.
4. Run the clean-machine acceptance test against configured mainnet or testnet
   using non-sensitive fixture state.
5. Enable automatic queueing for newly configured remote projects.
6. Keep existing projects opt-in for one release cycle.

## Non-Goals

- consciousness or hidden-reasoning transfer;
- semantic selection of authoritative state;
- last-write-wins timestamps;
- automatic conflict resolution;
- force-collapsing divergent remote heads;
- multi-parent envelopes in schema 1.0.0;
- multi-instance relayer consensus;
- guaranteeing recovery after simultaneous loss of every client and the
  relayer's exact index;
- uploading source files, diffs, journals, or prompt history as part of ACP
  state.
