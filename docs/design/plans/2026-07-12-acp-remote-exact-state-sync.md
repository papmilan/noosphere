# ACP Remote Exact-State Synchronization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add exact, lineage-based ACP synchronization through one durable relayer index without allowing semantic recall, timestamps, stale Git state, expired envelopes, or stale confirmations to become authority.

**Architecture:** A small standalone ACP protocol package supplies canonical encoding, digest, envelope validation, head-set digest, constants, and conformance fixtures to both products. The relayer stores immutable canonical bytes behind a backend interface and serializes exact-index transitions through its durable store; the MCP client independently validates every authority-bearing envelope, computes reconciliation purely, and applies remote state only through a single-use full-observation confirmation transaction.

**Tech Stack:** Node.js 22 ESM, `node:test`, Express 5, SHA-256, RFC 8785-compatible canonical JSON, filesystem atomic rename, existing Noosphere bearer authentication and durable queue.

## Global Constraints

- Work in an isolated worktree based on current `origin/main`; merge or cherry-pick the separately reviewed CI timeout repair `bc2e3af` before relying on the full MCP check.
- Preserve the ACP envelope schema at `1.0.0`; version remote sync as `noosphere.acp-sync/1` and reconciliation as `noosphere.acp-reconcile/1`.
- Semantic remember/recall must never select, fetch, rank, or publish exact ACP heads.
- Snapshot authority uses validated canonical envelope lineage only, never timestamps, response order, or relayer history metadata.
- Unsigned remote state is never applied automatically.
- `advanced` Git compatibility is historical-only unless the user supplies `--allow-stale-advanced`; repository-dependent assertions stay trust-downgraded after override.
- Expired envelopes are never actionable, including with overrides.
- Confirmation lifetime is at most five minutes and never exceeds the remote envelope expiry.
- Limits are 1,048,576 bytes per snapshot, 10,000 indexed snapshots per project, 32 concurrent heads, 200 validated ancestry envelopes per reconciliation, 268,435,456 indexed canonical bytes per project, and 16 live local confirmation objects.
- The empty head-set digest is `sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`.
- Cross-machine exact-sync claims require all clients to use the same durable `relayer_index_id`; Walrus credentials alone are insufficient.
- The first durable index is single-writer. Do not claim multi-instance CAS safety.
- Do not claim exact Walrus reads unless the installed SDK proves blob-ID retrieval; otherwise report `walrus-backed/relayer-indexed` and retain an exact relayer copy.
- Every task follows red-green-refactor, runs focused tests, passes `git diff --check`, receives specification review and code-quality review, then commits only its scoped files.

---

## File Structure

### New protocol package

- `noosphere-acp-protocol/package.json` — independently versioned wire protocol package.
- `noosphere-acp-protocol/index.js` — public exports only.
- `noosphere-acp-protocol/wire.js` — canonical JSON, snapshot digest, exact envelope decode/encode.
- `noosphere-acp-protocol/head-set.js` — normalized head arrays and canonical head-set digest.
- `noosphere-acp-protocol/constants.js` — protocol versions and hard limits.
- `noosphere-acp-protocol/schema.json` — canonical ACP 1.0 schema copied from the merged kernel.
- `noosphere-acp-protocol/tests/protocol.test.js` — shared conformance and limit fixtures.

### New relayer units

- `noosphere-relayer/snapshot-backend.js` — backend contract and atomic file implementation.
- `noosphere-relayer/walrus-snapshot-backend.js` — capability-gated Walrus replica wrapper with relayer exact-copy fallback.
- `noosphere-relayer/exact-state.js` — validation, immutable storage, quotas, lineage completeness, head CAS, history.
- `noosphere-relayer/exact-routes.js` — Express handlers and response mapping isolated from `index.js`.
- `noosphere-relayer/tests/exact-state.test.js` — backend/index/service tests.
- `noosphere-relayer/tests/acp-api.test.js` — authenticated HTTP, discovery, capability, and restart tests.

### New MCP units

- `noosphere-mcp/continuity/acp/reconcile.js` — pure validated-lineage reconciliation.
- `noosphere-mcp/continuity/acp/remote-client.js` — bounded authenticated exact-state HTTP client.
- `noosphere-mcp/continuity/acp/sync-metadata.js` — owner-only operational metadata, confirmation cache, quarantine.
- `noosphere-mcp/continuity/acp/sync.js` — discovery, ancestry fetch, confirmation issuance, apply-time revalidation, upload queue coordination.
- `noosphere-mcp/tests/acp-reconcile.test.js` — graph and compatibility truth table.
- `noosphere-mcp/tests/acp-remote-client.test.js` — response bounds and transport contract.
- `noosphere-mcp/tests/acp-sync.test.js` — confirmation, CAS write, quarantine, offline queue.
- `noosphere-mcp/tests/acp-remote-acceptance.test.js` — two-machine same-index acceptance.

### Existing files modified

- `noosphere-relayer/durable-store.js`, `index.js`, `package.json`, `npm-shrinkwrap.json`, `env.example`, `Dockerfile`, `tests/relayer.test.js`.
- `noosphere-mcp/continuity/acp/store.js`, `git-state.js`, `continuity/index.js`, `package.json`, `README.md`, `tests/acp-store.test.js`, `tests/continuity.test.js`, `tests/distribution.test.js`.
- Root `README.md`, `docs/DEPLOYMENT.md`, `docs/PRIVACY.md`.

---

### Task 1: Shared ACP Protocol Package

**Files:**
- Create: `noosphere-acp-protocol/package.json`
- Create: `noosphere-acp-protocol/index.js`
- Create: `noosphere-acp-protocol/wire.js`
- Create: `noosphere-acp-protocol/head-set.js`
- Create: `noosphere-acp-protocol/constants.js`
- Create: `noosphere-acp-protocol/schema.json`
- Create: `noosphere-acp-protocol/tests/protocol.test.js`
- Modify: `noosphere-mcp/continuity/acp/wire.js`
- Modify: `noosphere-mcp/continuity/acp/schema.json`
- Modify: `noosphere-mcp/package.json`
- Modify: `noosphere-relayer/package.json`
- Modify: `noosphere-relayer/npm-shrinkwrap.json`

**Interfaces:**
- Produces: `canonicalize(value)`, `digestEnvelope(envelope)`, `encodeEnvelope(state)`, `decodeEnvelope(input, options)`, `normalizeHeadIds(ids)`, `digestHeadSet(ids)`, `ACP_LIMITS`, `SYNC_PROTOCOL_VERSION`, and `RECONCILIATION_POLICY_VERSION`.
- Invariant: both products import package exports; no relayer relative import reaches into `noosphere-mcp`.

- [ ] **Step 1: Write failing protocol conformance tests**

```js
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ACP_LIMITS,
  canonicalize,
  digestHeadSet,
  normalizeHeadIds,
} from '../index.js';

describe('ACP protocol constants and head sets', () => {
  it('defines the normative bounded defaults', () => {
    assert.deepEqual(ACP_LIMITS, {
      snapshotBytes: 1_048_576,
      indexedSnapshotsPerProject: 10_000,
      concurrentHeadsPerProject: 32,
      ancestryEnvelopes: 200,
      indexedBytesPerProject: 268_435_456,
      liveConfirmations: 16,
    });
  });

  it('canonicalizes the empty head set to the normative digest', () => {
    assert.equal(canonicalize([]), '[]');
    assert.equal(digestHeadSet([]), 'sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945');
  });

  it('sorts and rejects duplicate or malformed head IDs', () => {
    assert.deepEqual(normalizeHeadIds([`sha256:${'b'.repeat(64)}`, `sha256:${'a'.repeat(64)}`]), [`sha256:${'a'.repeat(64)}`, `sha256:${'b'.repeat(64)}`]);
    assert.throws(() => normalizeHeadIds([`sha256:${'a'.repeat(64)}`, `sha256:${'a'.repeat(64)}`]), /duplicate-head/);
  });
});
```

- [ ] **Step 2: Run the protocol test and verify red**

Run: `node --test noosphere-acp-protocol/tests/protocol.test.js`

Expected: FAIL because the package exports do not exist.

- [ ] **Step 3: Implement constants and canonical head-set functions**

```js
// noosphere-acp-protocol/constants.js
export const SYNC_PROTOCOL_VERSION = 'noosphere.acp-sync/1';
export const RECONCILIATION_POLICY_VERSION = 'noosphere.acp-reconcile/1';
export const ACP_LIMITS = Object.freeze({
  snapshotBytes: 1_048_576,
  indexedSnapshotsPerProject: 10_000,
  concurrentHeadsPerProject: 32,
  ancestryEnvelopes: 200,
  indexedBytesPerProject: 268_435_456,
  liveConfirmations: 16,
});
```

```js
// noosphere-acp-protocol/head-set.js
import { createHash } from 'node:crypto';
import { canonicalize } from './wire.js';

const SNAPSHOT_ID = /^sha256:[0-9a-f]{64}$/;

export function normalizeHeadIds(ids) {
  if (!Array.isArray(ids)) throw new Error('invalid-head-set');
  const sorted = [...ids].sort();
  if (sorted.some((id) => !SNAPSHOT_ID.test(id))) throw new Error('invalid-head-id');
  if (sorted.some((id, index) => index > 0 && id === sorted[index - 1])) throw new Error('duplicate-head');
  return sorted;
}

export function digestHeadSet(ids) {
  const bytes = canonicalize(normalizeHeadIds(ids));
  return `sha256:${createHash('sha256').update(bytes, 'utf8').digest('hex')}`;
}
```

- [ ] **Step 4: Move the merged wire implementation and schema into the package**

Copy the complete behavior of `noosphere-mcp/continuity/acp/wire.js` and `schema.json`; preserve NFC and line-ending normalization, derived-field exclusion, digest verification, and domain construction. Parameterize domain construction so relayer decode can validate wire/schema/integrity without importing CLI runtime types:

```js
export function decodeEnvelope(input, { construct = (envelope) => ({ ok: true, envelope }), ...options } = {}) {
  const parsed = parseAndVerifyCanonicalEnvelope(input, options);
  if (!parsed.ok) return parsed;
  return construct(parsed.envelope, options);
}
```

The MCP adapter passes `createProjectState`; the relayer uses the wire-only result plus explicit required-field checks covered by the shared schema fixtures.

- [ ] **Step 5: Replace MCP-local implementation with package adapter and add package dependencies**

```js
// noosphere-mcp/continuity/acp/wire.js
import {
  canonicalize,
  decodeEnvelope as decodeWireEnvelope,
  digestEnvelope,
  encodeEnvelope,
} from '@noosphere/acp-protocol';
import { createProjectState } from './project-state.js';

export { canonicalize, digestEnvelope, encodeEnvelope };
export const decodeEnvelope = (input, options = {}) =>
  decodeWireEnvelope(input, { ...options, construct: createProjectState });
```

Use `"@noosphere/acp-protocol": "file:../noosphere-acp-protocol"` for repository development. Add `bundleDependencies: ["@noosphere/acp-protocol"]` to both published packages and verify their tarballs contain the dependency; publish the protocol package before replacing the file spec with `^0.1.0` in a release PR.

Run the dependency updates explicitly so the relayer shrinkwrap records the
local protocol package during repository development:

```bash
npm --prefix noosphere-mcp install ../noosphere-acp-protocol
npm --prefix noosphere-relayer install ../noosphere-acp-protocol
```

- [ ] **Step 6: Run focused and packaging verification**

Run:

```bash
node --test noosphere-acp-protocol/tests/protocol.test.js
npm --prefix noosphere-mcp exec -- node --test tests/acp-wire.test.js tests/acp-project-state.test.js
npm --prefix noosphere-mcp pack --dry-run
npm --prefix noosphere-relayer pack --dry-run
git diff --check
```

Expected: protocol and existing ACP tests PASS; both tarball listings include the bundled protocol package; no whitespace errors.

- [ ] **Step 7: Commit**

```bash
git add noosphere-acp-protocol noosphere-mcp/continuity/acp/wire.js noosphere-mcp/continuity/acp/schema.json noosphere-mcp/package.json noosphere-relayer/package.json noosphere-relayer/npm-shrinkwrap.json
git commit -m "feat: extract shared ACP wire protocol"
```

---

### Task 2: Durable Exact Snapshot Backend and Index

**Files:**
- Create: `noosphere-relayer/snapshot-backend.js`
- Create: `noosphere-relayer/walrus-snapshot-backend.js`
- Create: `noosphere-relayer/exact-state.js`
- Create: `noosphere-relayer/tests/exact-state.test.js`
- Modify: `noosphere-relayer/durable-store.js`
- Modify: `noosphere-relayer/package.json`
- Modify: `noosphere-relayer/env.example`

**Interfaces:**
- Consumes: shared protocol functions and `ACP_LIMITS` from Task 1.
- Produces: `FileSnapshotBackend.put/get/health`, `WalrusSnapshotBackend.put/get/health`, `DurableStore.readExactProject/updateExactProject`, and `ExactStateService.putSnapshot/getSnapshot/getHeads/getHistory/getCapabilities`.

- [ ] **Step 1: Write failing backend and head-index tests**

Add cases that assert: owner-only atomic exact writes; byte-identical idempotency; same ID/different bytes rejection; empty digest; sorted heads; child replaces parent; concurrent children create two heads; child-before-parent becomes complete after parent; restart rebuilds the same heads; 33rd head is rejected; count and byte quotas reject before publication.

```js
it('makes an out-of-order child actionable when its parent arrives', async () => {
  const { service } = await fixture();
  const childStored = await service.putSnapshot(PROJECT, childEnvelope, EMPTY_HEAD_DIGEST);
  assert.equal((await service.getHeads(PROJECT)).complete, false);
  await service.putSnapshot(PROJECT, parentEnvelope, childStored.heads_digest);
  assert.deepEqual((await service.getHeads(PROJECT)).heads, [childEnvelope.snapshot_id]);
  assert.equal((await service.getHeads(PROJECT)).complete, true);
});

it('retains bytes but not index metadata after stale head CAS', async () => {
  const { service, backend, index } = await fixture();
  const before = await service.getHeads(PROJECT);
  await assert.rejects(
    service.putSnapshot(PROJECT, childEnvelope, `sha256:${'f'.repeat(64)}`),
    /stale-heads/,
  );
  assert.deepEqual(await service.getHeads(PROJECT), before);
  assert.deepEqual(await backend.get(PROJECT, childEnvelope.snapshot_id), childCanonicalBytes);
  assert.equal((await index.readExactProject(PROJECT)).snapshots[childEnvelope.snapshot_id], undefined);
});
```

- [ ] **Step 2: Run focused relayer test and verify red**

Run: `npm --prefix noosphere-relayer exec -- node --test tests/exact-state.test.js`

Expected: FAIL because exact-state modules do not exist.

- [ ] **Step 3: Extend DurableStore compatibly**

Keep state version 1 readable and add an `exact_state` section plus a stable index identity. All mutations serialize through one write chain and receive a cloned project record:

```js
this.state = {
  version: 1,
  receipts: stored.receipts || {},
  pending: stored.pending || {},
  exact_state: stored.exact_state || {
    version: 1,
    relayer_index_id: `sha256:${randomBytes(32).toString('hex')}`,
    projects: {},
  },
};

async updateExactProject(projectId, mutation) {
  await this.initialize();
  return this.enqueueWrite(async () => {
    const current = structuredClone(this.state.exact_state.projects[projectId] || emptyProjectRecord());
    const next = await mutation(current);
    this.state.exact_state.projects[projectId] = next;
    await this.writeState();
    return structuredClone(next);
  });
}
```

Do not call `save()` from inside the serialized mutation; use one non-reentrant writer primitive.

- [ ] **Step 4: Implement FileSnapshotBackend**

Derive paths from SHA-256 hashes of project ID and validated snapshot ID, never raw input. Write mode 0600 temp files, rename atomically, and compare existing bytes before returning idempotent success.

```js
async put(projectId, snapshotId, canonicalBytes) {
  assertCanonicalId(snapshotId);
  const target = this.pathFor(projectId, snapshotId);
  const existing = await readFile(target).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (existing && !existing.equals(canonicalBytes)) throw exactError('snapshot-integrity-conflict');
  if (!existing) await atomicOwnerOnlyWrite(target, canonicalBytes);
  return { backend: 'file', locator: snapshotId, bytes: canonicalBytes.length };
}
```

- [ ] **Step 5: Implement ExactStateService and deterministic recomputation**

`putSnapshot` must validate size and canonical bytes, store bytes first, then atomically recompute all parent edges, completeness, sorted heads, total indexed bytes, and digest. Expected-head mismatch returns current heads without mutation. Store expired envelopes as immutable history but mark them non-actionable.

“Without mutation” applies to the exact index record: stale CAS must not add
snapshot metadata, change completeness, or change heads. The immutable backend
bytes written before CAS may remain unreferenced and are adopted idempotently
when a later request succeeds against the current head digest.

```js
function recomputeProject(record) {
  const parentIds = new Set(Object.values(record.snapshots).map((item) => item.parent_snapshot_id).filter(Boolean));
  const heads = Object.keys(record.snapshots).filter((id) => !parentIds.has(id)).sort();
  return {
    ...record,
    heads,
    heads_digest: digestHeadSet(heads),
    complete: Object.values(record.snapshots).every((item) => item.parent_snapshot_id == null || record.snapshots[item.parent_snapshot_id]),
  };
}
```

- [ ] **Step 6: Implement honest Walrus capability wrapper**

The adapter must expose exact retrieval only when an injected SDK adapter proves `getByBlobId`. Otherwise it uploads a replica, stores the exact relayer copy through `FileSnapshotBackend`, and reports:

```js
{
  deployment_mode: 'walrus-backed/relayer-indexed',
  exact_bytes_durable: fileHealth.durable,
  index_durable: indexHealth.durable,
  cross_machine_recoverable: shared && fileHealth.durable && indexHealth.durable,
}
```

Never call semantic `recall` in this module.

- [ ] **Step 7: Run focused tests and commit**

Run:

```bash
npm --prefix noosphere-relayer exec -- node --test tests/exact-state.test.js tests/reliability.test.js
npm --prefix noosphere-relayer run check
git diff --check
```

Expected: focused suites PASS and syntax check includes every new module.

```bash
git add noosphere-relayer/snapshot-backend.js noosphere-relayer/walrus-snapshot-backend.js noosphere-relayer/exact-state.js noosphere-relayer/durable-store.js noosphere-relayer/tests/exact-state.test.js noosphere-relayer/package.json noosphere-relayer/env.example
git commit -m "feat: add durable ACP exact-state index"
```

---

### Task 3: Authenticated Exact-State HTTP API and Queue Recovery

**Files:**
- Create: `noosphere-relayer/exact-routes.js`
- Create: `noosphere-relayer/tests/acp-api.test.js`
- Modify: `noosphere-relayer/index.js`
- Modify: `noosphere-relayer/Dockerfile`
- Modify: `noosphere-relayer/package.json`
- Modify: `noosphere-relayer/tests/relayer.test.js`

**Interfaces:**
- Consumes: `ExactStateService` from Task 2.
- Produces: `GET /v1/acp/capabilities`, snapshot POST/GET, heads GET, bounded history GET, ACP queue job dispatch, discovery and OpenAPI entries.

- [ ] **Step 1: Write failing API contract tests**

Cover bearer authentication, 201/200 idempotency, ETag equality, empty heads, stale expected digest 409, head-limit 409, 413, 422, 507, history limit 1..200, capability topology, log redaction, queued 202 visibility, and restart publication only after bytes are durable.

```js
it('does not publish a queued head before exact bytes are durable', async () => {
  backend.put = async () => { throw Object.assign(new Error('offline'), { retryable: true }); };
  const upload = await api.postSnapshot(envelope);
  assert.equal(upload.status, 202);
  assert.deepEqual((await api.heads()).body.heads, []);
});
```

- [ ] **Step 2: Run API tests and verify red**

Run: `npm --prefix noosphere-relayer exec -- node --test tests/acp-api.test.js`

Expected: FAIL with missing routes.

- [ ] **Step 3: Add isolated route handlers**

`exact-routes.js` maps typed service errors without interpreting Project State:

```js
router.post('/projects/:project_id/acp/snapshots', asyncHandler(async (req, res) => {
  const result = await service.putSnapshot(req.params.project_id, req.body.envelope, req.body.expected_heads_digest);
  res.status(result.created ? 201 : 200).json({ success: true, ...result });
}));
router.get('/projects/:project_id/acp/heads', asyncHandler(async (req, res) => {
  res.json({ success: true, ...await service.getHeads(req.params.project_id) });
}));
router.get('/projects/:project_id/acp/snapshots/:snapshot_id', asyncHandler(async (req, res) => {
  const result = await service.getSnapshot(req.params.project_id, req.params.snapshot_id);
  res.set('ETag', `"${result.snapshot_id}"`).type('application/json').send(result.bytes);
}));
router.get('/projects/:project_id/acp/history', asyncHandler(async (req, res) => {
  const limit = parseBoundedHistoryLimit(req.query.limit, 1, 200);
  res.json({ success: true, history: await service.getHistory(req.params.project_id, { head: req.query.head, limit }) });
}));
```

Reject the serialized canonical envelope above 1 MiB even though Express accepts 2 MiB JSON.

- [ ] **Step 4: Add ACP-specific durable queue processing**

Queue jobs use `kind: 'acp-snapshot'` and canonical bytes. Dispatch explicitly:

```js
if (job.kind === 'acp-snapshot') return processAcpSnapshotJob(job);
if (job.kind === 'memory-action') return processMemoryJob(job);
throw new Error(`unsupported-job-kind:${job.kind}`);
```

The completion order is bytes durable → exact index/head CAS durable → receipt durable → pending plaintext removed. Recovery repeats the same content-addressed steps.

- [ ] **Step 5: Extend readiness, discovery, OpenAPI, Docker, and package manifests**

Advertise deployment mode, durability booleans, stable index ID, protocol/policy versions, routes, limits, status bodies, and authentication. Provision a configurable durable exact snapshot directory in the container. Do not advertise cross-machine recovery when either health dimension is false.

- [ ] **Step 6: Run API/regression tests and commit**

```bash
npm --prefix noosphere-relayer exec -- node --test tests/acp-api.test.js tests/relayer.test.js tests/reliability.test.js
npm --prefix noosphere-relayer run check
npm --prefix noosphere-mcp exec -- node --test tests/distribution.test.js
git diff --check
```

Expected: all focused suites PASS; discovery/OpenAPI include exact routes; packaging includes new modules.

```bash
git add noosphere-relayer/exact-routes.js noosphere-relayer/index.js noosphere-relayer/Dockerfile noosphere-relayer/package.json noosphere-relayer/tests/acp-api.test.js noosphere-relayer/tests/relayer.test.js
git commit -m "feat: expose authenticated ACP exact-state API"
```

---

### Task 4: Pure Client Reconciliation and Remote Transport

**Files:**
- Create: `noosphere-mcp/continuity/acp/reconcile.js`
- Create: `noosphere-mcp/continuity/acp/trust-projection.js`
- Create: `noosphere-mcp/continuity/acp/remote-client.js`
- Create: `noosphere-mcp/tests/acp-reconcile.test.js`
- Create: `noosphere-mcp/tests/acp-remote-client.test.js`
- Modify: `noosphere-mcp/package.json`

**Interfaces:**
- Consumes: protocol constants, canonical decoder, existing `classifyCompatibility`.
- Produces: `reconcileExactState(input) -> action plan`, `projectAdvancedTrust(state) -> trust overlay`, and `RemoteStateClient` methods `capabilities`, `putSnapshot`, `getHeads`, `getSnapshot`, `getHistory`.

- [ ] **Step 1: Write the reconciliation truth-table tests**

Include identical, remote descendant, local descendant of all heads, divergence, multiple heads, missing/over-200 ancestry, metadata/canonical disagreement, foreign identity, expired state, response-order stability, and every Git status. Assert `advanced` returns `historical-advanced` by default and a confirmation candidate only when policy explicitly allows it.

```js
assert.deepEqual(reconcileExactState({ ...fixture, compatibility: { status: 'advanced' }, policy: DEFAULT_POLICY }), {
  action: 'historical-advanced',
  candidate_snapshot_id: REMOTE_ID,
  actionable: false,
  trust_downgrade: 1,
});
```

Add an advanced trust-projection fixture with: one assertion carrying a
non-null `repository_fingerprint`; one assertion with null binding; `file`,
`commit`, `command`, `test`, `journal`, and `external` references; and two next
actions. Assert the pure overlay marks every non-null-bound assertion, the four
repository reference kinds, and **all** next actions non-authoritative while
leaving the immutable envelope and its snapshot ID unchanged.

- [ ] **Step 2: Run reconciler test and verify red**

Run: `npm --prefix noosphere-mcp exec -- node --test tests/acp-reconcile.test.js`

Expected: FAIL because the reconciler is absent.

- [ ] **Step 3: Implement the pure graph walk**

Build authority edges only from validated envelopes. Sort IDs before traversal and cap validated nodes at 200. Treat history metadata only as fetch hints. Return data, never perform I/O or mutate states.

```js
export function reconcileExactState({ local, remoteHeads, validatedById, compatibility, clock, policy }) {
  if (remoteHeads.some((id) => isExpired(validatedById.get(id), clock))) return expiredResult();
  if (validatedById.size > ACP_LIMITS.ancestryEnvelopes) return { action: 'incomplete-lineage', actionable: false };
  // deterministic reachability and action selection
}
```

Implement the deterministic runtime overlay without changing canonical bytes:

```js
// trust-projection.js
const REPOSITORY_REFERENCE_KINDS = new Set(['file', 'commit', 'command', 'test']);
const ASSERTION_COLLECTIONS = ['plan', 'completed_work', 'decisions', 'evidence', 'assumptions', 'rejected_approaches', 'unknowns', 'blockers', 'risks', 'next_actions'];

export function projectAdvancedTrust(state) {
  const envelope = state.envelope;
  const boundAssertionIds = ASSERTION_COLLECTIONS.flatMap((name) =>
    envelope[name].filter((item) => item.repository_fingerprint !== null).map((item) => item.id));
  return Object.freeze({
    trustDowngrade: 1,
    nonAuthoritativeAssertionIds: Object.freeze([...new Set(boundAssertionIds)].sort()),
    nonAuthoritativeReferenceIds: Object.freeze(envelope.references.filter((item) => REPOSITORY_REFERENCE_KINDS.has(item.kind)).map((item) => item.id).sort()),
    nonAuthoritativeNextActionIds: Object.freeze(envelope.next_actions.map((item) => item.id).sort()),
  });
}
```

This overlay is input to rendering and action selection; it is not encoded into
the envelope and therefore cannot forge a new snapshot identity.

- [ ] **Step 4: Write failing bounded HTTP client tests**

Test bearer header, timeout/abort, 1 MiB body cap, ETag/snapshot mismatch, malformed JSON, unsupported capabilities, index-ID propagation, typed 409/413/422/507 results, and no semantic endpoints.

- [ ] **Step 5: Implement RemoteStateClient**

Inject `fetch`, clock, token, and timeout for deterministic tests. `getSnapshot` must return raw bytes plus headers so the coordinator can independently canonicalize and validate them.

```js
export class RemoteStateClient {
  constructor({ baseUrl, token, fetchImpl = fetch, timeoutMs = 8_000 }) { /* store bounded dependencies */ }
  capabilities() { return this.request('/v1/acp/capabilities'); }
  getHeads(projectId) { return this.request(`/v1/projects/${encodeURIComponent(projectId)}/acp/heads`); }
  getSnapshot(projectId, snapshotId) { return this.requestBytes(/* exact URL */, ACP_LIMITS.snapshotBytes); }
}
```

- [ ] **Step 6: Run focused tests and commit**

```bash
npm --prefix noosphere-mcp exec -- node --test tests/acp-reconcile.test.js tests/acp-remote-client.test.js tests/acp-git-state.test.js tests/acp-wire.test.js
npm --prefix noosphere-mcp run check
git diff --check
```

Expected: focused suites and full MCP check PASS after the CI timeout prerequisite is present.

```bash
git add noosphere-mcp/continuity/acp/reconcile.js noosphere-mcp/continuity/acp/trust-projection.js noosphere-mcp/continuity/acp/remote-client.js noosphere-mcp/tests/acp-reconcile.test.js noosphere-mcp/tests/acp-remote-client.test.js noosphere-mcp/package.json
git commit -m "feat: add deterministic ACP remote reconciliation"
```

---

### Task 5: Confirmation Cache, Quarantine, and Compare-and-Write Store

**Files:**
- Create: `noosphere-mcp/continuity/acp/sync-metadata.js`
- Create: `noosphere-mcp/tests/acp-sync-metadata.test.js`
- Modify: `noosphere-mcp/continuity/acp/store.js`
- Modify: `noosphere-mcp/tests/acp-store.test.js`

**Interfaces:**
- Produces: `readSyncMetadata`, `writeSyncMetadata`, `issueConfirmation`, `consumeConfirmation`, `quarantineBytes`, `digestRepositoryObservation`, and `writeStateIfCurrent(root, state, expectedSnapshotId, options)`.

- [ ] **Step 1: Write failing metadata and store-CAS tests**

Assert owner-only atomic metadata, maximum 16 live confirmations, no live eviction, five-minute/remote-expiry bound, hash verification, persistence across processes, delete-before-validation single use, `confirmation-missing`, path-hostile quarantine names, symlink rejection, and expected-null/current-ID compare-and-write behavior.

```js
it('consumes a confirmation once even when validation later fails', async () => {
  const issued = await issueConfirmation(root, observation, clock);
  assert.ok(await consumeConfirmation(root, issued.confirmation_id, clock));
  await assert.rejects(() => consumeConfirmation(root, issued.confirmation_id, clock), /confirmation-missing/);
});
```

- [ ] **Step 2: Run focused tests and verify red**

Run: `npm --prefix noosphere-mcp exec -- node --test tests/acp-sync-metadata.test.js tests/acp-store.test.js`

Expected: FAIL with missing metadata and CAS exports.

- [ ] **Step 3: Implement canonical full-observation confirmations**

Confirmation contains remote snapshot ID, current local ID or null, remote head-set digest, complete repository-observation digest, stable relayer index ID, sync version, policy version, action, advanced override, expiry, and its own canonical digest. Store the complete object under its ID in `.noosphere/continuity-sync.json` mode 0600.

```js
export function digestRepositoryObservation(observed) {
  return sha256(canonicalize({
    root_identity: observed.root_identity,
    head: observed.head,
    branch: observed.branch,
    dirty: observed.dirty,
    workspace_fingerprint: observed.workspace_fingerprint,
    ancestors: [...observed.ancestors].sort(),
  }));
}
```

- [ ] **Step 4: Implement path-safe quarantine**

Only validated lowercase IDs map to `sha256-<64hex>.json`; otherwise hash received bytes locally. Open the fixed quarantine directory owner-only, reject a symlink directory or target, and create files with exclusive `wx` mode 0600. Never use raw project IDs, headers, or remote text.

- [ ] **Step 5: Add compare-and-write to the local state store**

Immediately before rename, re-read the current envelope and require its ID to equal `expectedSnapshotId` including explicit null. Generate both temporary files first. If either rename fails, restore the prior pair from owner-only backups so the documented pair atomicity is true.

```js
export async function writeStateIfCurrent(root, state, expectedSnapshotId, options = {}) {
  const current = await readState(root, options);
  const currentId = current?.ok ? current.state.envelope.snapshot_id : null;
  if (currentId !== expectedSnapshotId) throw storeError('confirmation-stale');
  return writeStateTransaction(root, state, options);
}
```

- [ ] **Step 6: Run focused tests and commit**

```bash
npm --prefix noosphere-mcp exec -- node --test tests/acp-sync-metadata.test.js tests/acp-store.test.js
git diff --check
```

Expected: focused suites PASS and failure injection leaves the prior pair intact.

```bash
git add noosphere-mcp/continuity/acp/sync-metadata.js noosphere-mcp/continuity/acp/store.js noosphere-mcp/tests/acp-sync-metadata.test.js noosphere-mcp/tests/acp-store.test.js
git commit -m "feat: add ACP confirmation and quarantine state"
```

---

### Task 6: Sync Coordinator and Apply-Time Revalidation

**Files:**
- Create: `noosphere-mcp/continuity/acp/sync.js`
- Create: `noosphere-mcp/tests/acp-sync.test.js`
- Modify: `noosphere-mcp/continuity/acp/git-state.js`
- Modify: `noosphere-mcp/continuity/acp/render.js`
- Modify: `noosphere-mcp/tests/acp-git-state.test.js`
- Modify: `noosphere-mcp/tests/acp-render.test.js`

**Interfaces:**
- Consumes: Tasks 4–5 clients, reconciler, metadata, store CAS, and repository observation.
- Produces: `discoverRemoteState`, `pushLocalState`, `issueRemoteConfirmation`, `applyRemoteConfirmation`, `syncProjectState`, `listRemoteHistory`, and `listQuarantine`.

- [ ] **Step 1: Write failing coordinator security tests**

For each confirmation field independently change: remote ID, local ID/null, head digest, repository digest, index ID, protocol version, policy version, action, override, and expiry. Assert `confirmation-stale`, consumed confirmation, and byte-identical unchanged local pair. Also mutate remote bytes between discovery and apply and between reconciliation and the final barrier.

- [ ] **Step 2: Write failing advanced/expired/ancestry tests**

Assert advanced is stored only as historical metadata by default; override requires a newly issued confirmation binding `allow_stale_advanced: true`; the Task 4 trust overlay marks non-null-bound assertions and repository reference kinds non-authoritative, suppresses every remote next action from the authoritative kernel, and leaves canonical bytes unchanged; expired state never issues confirmation; every authority-bearing ancestor is fetched and validated; over-200 ancestry is incomplete.

- [ ] **Step 3: Run coordinator test and verify red**

Run: `npm --prefix noosphere-mcp exec -- node --test tests/acp-sync.test.js`

Expected: FAIL because the coordinator is absent.

- [ ] **Step 4: Implement discovery and confirmation issuance**

Fetch capabilities and heads; reject unsupported versions/topology claims; use metadata only to discover paths; fetch exact bytes for each path; validate ETag, canonical digest, schema, project/root binding, and expiry; capture Git once; run reconciliation; issue a bounded confirmation only for exact/compatible or explicitly allowed advanced candidates.

- [ ] **Step 5: Implement the full apply barrier**

Consume confirmation before validation. Then re-read local state, heads, capabilities, remote bytes, Git, and versions; rerun reconciliation; immediately repeat all of those observations; finally call `writeStateIfCurrent` with the bound local ID.

```js
export async function applyRemoteConfirmation(root, confirmationId, deps) {
  const confirmation = await consumeConfirmation(root, confirmationId, deps.clock);
  const first = await observeAndReconcile(root, confirmation, deps);
  assertMatchesConfirmation(first, confirmation);
  const final = await observeAndReconcile(root, confirmation, deps);
  assertMatchesConfirmation(final, confirmation);
  assertSameObservation(first, final);
  return writeStateIfCurrent(root, final.remoteState, confirmation.local_snapshot_id, { compatibility: final.compatibility });
}
```

Any thrown mismatch maps to `confirmation-stale`; no code path retries application automatically.

When an advanced override succeeds, pass `projectAdvancedTrust(state)` into
`renderKernel`. Render a visible stale-history warning, exclude every ID in
`nonAuthoritativeNextActionIds` from authoritative next actions, and label
bound assertions/references as downgraded if they are shown. The underlying
`continuity.json` remains the exact remote envelope.

- [ ] **Step 6: Run focused tests and commit**

```bash
npm --prefix noosphere-mcp exec -- node --test tests/acp-sync.test.js tests/acp-reconcile.test.js tests/acp-remote-client.test.js tests/acp-git-state.test.js tests/acp-render.test.js tests/acp-store.test.js
git diff --check
```

Expected: all focused sync tests PASS.

```bash
git add noosphere-mcp/continuity/acp/sync.js noosphere-mcp/continuity/acp/git-state.js noosphere-mcp/continuity/acp/render.js noosphere-mcp/tests/acp-sync.test.js noosphere-mcp/tests/acp-git-state.test.js noosphere-mcp/tests/acp-render.test.js
git commit -m "feat: enforce ACP apply-time confirmation"
```

---

### Task 7: CLI Commands, Offline Replication, Activation, and Restore

**Files:**
- Modify: `noosphere-mcp/continuity/index.js`
- Modify: `noosphere-mcp/package.json`
- Modify: `noosphere-mcp/tests/continuity.test.js`
- Modify: `noosphere-mcp/tests/acp-store.test.js`

**Interfaces:**
- Consumes: coordinator commands from Task 6 and existing project config/authentication.
- Produces: `noosphere state sync|push|pull|history|quarantine`, JSON output, `--confirm-remote`, `--allow-stale-advanced`, offline handoff queueing, activation discovery, and restore discovery.

- [ ] **Step 1: Write failing CLI parsing and JSON-contract tests**

Assert every subcommand, stable JSON action codes, snapshot ID alone rejected as confirmation, confirmation ID accepted only from cache, advanced override binding, `NOOSPHERE_ACP_SYNC=false`, and no envelope contents in ordinary status output.

- [ ] **Step 2: Write failing offline/activation/restore tests**

Assert local handoff succeeds while relayer is offline and persists a retry job; restart retries idempotently; activation may discover/cache but never apply; restore reports confirmation but preserves typed intent when exact sync is unavailable; semantic endpoints are not called.

- [ ] **Step 3: Run focused CLI tests and verify red**

Run: `npm --prefix noosphere-mcp exec -- node --test tests/acp-store.test.js tests/continuity.test.js`

Expected: FAIL on missing state subcommands and sync queue behavior.

- [ ] **Step 4: Add state subcommand dispatch without expanding index.js authority logic**

Keep parsing and presentation in `continuity/index.js`; call coordinator functions for decisions:

```js
switch (args[1]) {
  case 'sync': return printSync(await syncProjectState(root, cliSyncOptions()));
  case 'push': return printSync(await pushLocalState(root, cliSyncOptions()));
  case 'pull': return printSync(await discoverRemoteState(root, cliSyncOptions()));
  case 'history': return printSync(await listRemoteHistory(root, cliSyncOptions()));
  case 'quarantine': return printSync(await listQuarantine(root));
  default: return stateFromCli(root);
}
```

- [ ] **Step 5: Connect local-first handoff and bounded background retry**

After `writeState` succeeds, enqueue canonical upload when configured. Do not turn remote failure into handoff failure. Persist attempts and bounded backoff in operational sync metadata; never put envelope content in logs.

- [ ] **Step 6: Connect activation and restore discovery only**

Both commands may emit/cache a confirmation object. Neither calls apply. `--json` never applies unless the invocation also supplies a valid cached `--confirm-remote <confirmation_id>`; advanced additionally requires `--allow-stale-advanced` matching the cached object.

- [ ] **Step 7: Run focused/full tests and commit**

```bash
npm --prefix noosphere-mcp exec -- node --test tests/acp-store.test.js tests/acp-sync.test.js tests/continuity.test.js
npm --prefix noosphere-mcp run check
git diff --check
```

Expected: focused and full MCP suites PASS with the CI timeout prerequisite.

```bash
git add noosphere-mcp/continuity/index.js noosphere-mcp/package.json noosphere-mcp/tests/continuity.test.js noosphere-mcp/tests/acp-store.test.js
git commit -m "feat: expose safe ACP remote sync commands"
```

---

### Task 8: Clean-Machine Acceptance, Documentation, and Release Verification

**Files:**
- Create: `noosphere-mcp/tests/acp-remote-acceptance.test.js`
- Modify: `noosphere-mcp/tests/distribution.test.js`
- Modify: `noosphere-mcp/README.md`
- Modify: `noosphere-relayer/NOOSPHERE_INTEGRATION.md`
- Modify: `noosphere-relayer/env.example`
- Modify: `README.md`
- Modify: `docs/DEPLOYMENT.md`
- Modify: `docs/PRIVACY.md`

**Interfaces:**
- Consumes: completed relayer and MCP slice.
- Produces: executable two-machine proof, topology-safe operator guidance, exact package/container contents, and final verification evidence.

- [ ] **Step 1: Write the failing two-machine acceptance test**

Start one durable relayer fixture with semantic recall disabled. Machine A and B are separate temporary Git clones at the same revision and configured with the same relayer endpoint. Each client obtains `relayer_index_id` from the authenticated capability response; assert the observed values match the server-owned durable index identity. A creates/pushes; B discovers without applying; B applies using the cached full-observation confirmation; assert snapshot/digest equality and deterministic kernel. Add negative siblings that switch B to a second relayer with a different server-issued index ID, report local-only capability, stale the confirmation, expire the state, and exercise advanced default history-only behavior.

- [ ] **Step 2: Run acceptance test and verify red**

Run: `npm --prefix noosphere-mcp exec -- node --test tests/acp-remote-acceptance.test.js`

Expected: FAIL until the real CLI/relayer integration satisfies the fixture.

- [ ] **Step 3: Complete only integration gaps exposed by the acceptance test**

Do not bypass public CLI or HTTP interfaces in the positive test. Fix wiring in the owning focused module, add its focused regression there, rerun that focused suite, then rerun acceptance.

- [ ] **Step 4: Document topology and trust precisely**

Documentation must state:

```text
Cross-machine exact synchronization requires every client to use the same durable relayer index. Sharing Walrus credentials alone is not sufficient. "walrus-backed/relayer-indexed" means Walrus replicates bytes while exact lookup and heads still depend on that relayer index.
```

Document all three modes, durability dimensions, quotas, confirmation expiry/single use, `advanced` override consequences, quarantine behavior, offline queue status, and recovery limitations. Do not use “shared consciousness” or hidden-reasoning claims.

- [ ] **Step 5: Verify package and container contents**

```bash
npm --prefix noosphere-mcp pack --dry-run
npm --prefix noosphere-relayer pack --dry-run
docker build -t noosphere-relayer:acp-sync noosphere-relayer
npm --prefix noosphere-mcp exec -- node --test tests/distribution.test.js
```

Expected: protocol bundle and all new runtime modules are present; secrets, runtime state, confirmations, quarantine, and fixture output are absent.

- [ ] **Step 6: Run final verification**

```bash
node --test noosphere-acp-protocol/tests/protocol.test.js
npm --prefix noosphere-relayer run check
npm --prefix noosphere-mcp run check
npm --prefix noosphere-mcp exec -- node --test tests/acp-remote-acceptance.test.js
npm --prefix noosphere-relayer audit --omit=dev
npm --prefix noosphere-mcp audit --omit=dev
git diff --check
git status --short
```

Expected: every test reports zero failures, audits report zero known vulnerabilities, diff check exits 0, and status contains only the intended Task 8 files before commit.

- [ ] **Step 7: Request final code review and commit**

Use the requesting-code-review skill for the entire `origin/main...HEAD` range. Resolve every actionable authority, durability, crash-consistency, packaging, privacy, and cross-platform finding; rerun Step 6 afterward.

```bash
git add noosphere-mcp/tests/acp-remote-acceptance.test.js noosphere-mcp/tests/distribution.test.js noosphere-mcp/README.md noosphere-relayer/NOOSPHERE_INTEGRATION.md noosphere-relayer/env.example README.md docs/DEPLOYMENT.md docs/PRIVACY.md
git commit -m "docs: complete ACP exact-state sync rollout"
```

---

## Execution Order and Review Gates

1. Task 1 must land before either product imports protocol code.
2. Task 2 must pass restart and out-of-order lineage tests before HTTP exposure.
3. Task 3 must prove authenticated durability and honest capabilities before any client integration.
4. Tasks 4 and 5 may be implemented by separate subagents after Task 1 because they touch disjoint client units; both must merge before Task 6.
5. Task 6 is the security gate: no CLI exposure until stale-confirmation mutation tests pass.
6. Task 7 exposes the feature but keeps it opt-in.
7. Task 8 is the only completion gate and must use public interfaces end to end.

Recommended subagent-driven dependency graph:

```text
Task 1
  -> Task 2 -> Task 3 -----------+
  -> Task 4 ----+                |
  -> Task 5 ----+-> Task 6 -> Task 7 -> Task 8
```
