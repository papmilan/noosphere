# ACP Remote Exact-State Synchronization Design

**Date:** 2026-07-12
**Status:** Approved direction; written specification awaiting user review
**Normative decision:** `docs/adr/0002-acp-remote-lineage-authority.md`

## Purpose

ACP v1 gives one checkout a validated Project State Envelope and compact
continuity kernel. V1.1 makes the exact canonical envelope durable across
machines and agent products without treating semantic memory as authoritative
state.

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
  machine;
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
4. If exactly one candidate is a safe fast-forward and Git-compatible, it is
   presented for explicit confirmation. On confirmation it is written to
   `continuity.json`; `continuity.md` is regenerated locally.
5. Divergent, incomplete, foreign, or invalid candidates are not applied.

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
  -> safe fast-forward OR explicit divergence/quarantine
```

Semantic remember/recall remains a parallel subsystem. It may help an agent
discover relevant history, but it does not participate in exact state head
selection.

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
operation, and protocol reference behavior.

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

The file index supports one relayer writer process. A later Postgres index can
implement the same compare-and-set contract for multiple instances.

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
- `422`: invalid ACP envelope, digest, project binding, or parent metadata.

The idempotency key is `acp-snapshot:<snapshot_id>`. A completed receipt may be
replayed without uploading or changing heads again.

### List heads

`GET /v1/projects/:project_id/acp/heads`

Returns the sorted head records, head-set digest, completeness status, and
backend mode. It never returns semantic recall results.

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
```

The reconciler does not perform I/O. Its tests use complete graph fixtures.

### Sync coordinator

`noosphere-mcp/continuity/acp/sync.js` performs remote calls, validates bytes,
invokes the reconciler, writes safe local fast-forwards through `store.js`, and
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
  "pending": []
}
```

It is excluded from Git and has no authority over `continuity.json`.

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
7. If local is null and exactly one complete, Git-actionable remote head
   exists, return `remote-only-restore` as a confirmation-required candidate.
8. If exactly one remote head descends from local and is Git-actionable,
   return `fast-forward-local` as a confirmation-required candidate.
9. If local descends from every remote head, return `push-local`.
10. If ancestry is missing, return `incomplete-lineage`; fetch up to the
    bounded history limit before making another decision.
11. Otherwise return `diverged`, preserve every head, and construct an ACP
    synchronization conflict referencing the head IDs.

The algorithm is deterministic for the same graph and inputs.

### Git actionability predicate

The coordinator uses the existing pure `classifyCompatibility` contract with
one captured repository observation: root identity, HEAD, branch, dirty flag,
workspace fingerprint, and a bounded list of HEAD ancestors. `exact`,
`compatible`, and `advanced` are actionable; `diverged`, `foreign`, and
`unknown` are not. A detached HEAD is represented by a null branch and is
handled by the same comparison. A missing Git repository or missing root
commit is `unknown`. Dirty state is not ignored: at equal HEAD, differences in
branch, dirty flag, or workspace fingerprint downgrade `exact` to
`compatible`; they do not authorize source-file mutation. A sync protocol or
policy version unsupported by the client is non-actionable. The observation
is captured once per reconciliation run so repository changes cannot alter a
decision halfway through evaluation.

## Divergence and Resolution

Divergence never overwrites `continuity.json`. The coordinator writes a
generated conflict record to `.noosphere/continuity-sync.json` and prints each
head with repository and provenance information. Remote snapshots may be
stored in `.noosphere/quarantine/` for inspection.

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
  a remote fast-forward or empty-local restore. `--json` reports the candidate
  and exits without applying unless `--confirm-remote <snapshot_id>` is
  supplied in a user-approved invocation. Binding confirmation to the exact ID
  prevents a head change between review and application.
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
- `noosphere restore` invokes exact ACP restore after typed intent restoration;
  failure to find exact state does not erase restored intent files.
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
- Stale head-set digest: fetch current heads and rerun pure reconciliation.
- Missing parent: fetch bounded history; otherwise report incomplete lineage.
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
- stable ordering independent of response order and timestamps.

### Relayer

- content-idempotent upload;
- same ID/different bytes rejection;
- exact retrieval byte equality;
- sorted head set and stable digest;
- parent replacement and concurrent head addition;
- stale compare-and-set conflict;
- queued upload does not publish head early;
- restart recovery publishes head after durable bytes;
- child-before-parent upload becomes complete and yields the correct head,
  including after restart;
- completed receipt avoids re-upload;
- request size, auth, rate limit, CORS, and log redaction;
- file and Walrus-backed adapter contract tests.

### CLI

- local handoff succeeds while remote is offline;
- pending state survives restart;
- push and exact pull round trip;
- confirmed safe fast-forward regeneration of kernel;
- automatic activation never applies unsigned remote state;
- fresh-machine restore;
- divergence preserves local state;
- invalid/foreign remote state is quarantined;
- `--json` results are stable and contain no envelope content unless explicitly
  requested by `state --json`;
- disabling sync performs no network calls.

### Clean-machine acceptance

1. Machine A creates and pushes a unique ACP snapshot.
2. Machine B clones the same Git revision with no `.noosphere` state.
3. Machine B initializes project identity and performs exact sync, which
   reports the unsigned candidate without applying it.
4. Machine B applies that exact candidate with
   `--confirm-remote <snapshot_id>`.
5. Restored canonical JSON has the same snapshot ID and canonical digest.
6. Locally rendered kernel matches Machine A byte-for-byte for the same Git
   observation and policy.
7. Semantic recall is disabled during this test to prove exact-state authority.

## Success Criteria

- Exact state survives loss of a client checkout and is restorable through the
  configured relayer.
- No successful sync uses semantic recall to select state.
- No concurrent head is silently discarded.
- Offline handoffs remain successful and upload later.
- Identical upload retries produce one logical snapshot and one head result.
- Invalid or foreign remote state never replaces local state.
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
