# Remote Project Memory PR 2 Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure, owner-scoped Project Memory core on the in-memory repository, with deterministic matching, lifecycle, checkpoint, resume, and pagination behavior.

**Architecture:** `ProjectMemoryService` is the use-case boundary. It accepts trusted internal `ownerScope`, uses injected clock/ID dependencies, normalizes and projects records, and maps repository failures to the public error model. The repository only stores projected values and atomically enforces persistence invariants; it never normalizes names, creates timestamps, selects matches, or maps public errors.

**Tech Stack:** Node.js 22 ESM, `node:test`, `node:assert/strict`, `node:crypto`, JSON Schema draft 2020-12; no new runtime dependencies.

## Global Constraints

- Touch only `noosphere-remote-mcp` and Project Memory design/plan/test files; preserve all existing Noosphere package behavior.
- Do not add HTTP/MCP transport, OIDC, PostgreSQL, migrations, Docker/deployment, Walrus, transcripts, local filesystem access, or PR 3 work.
- `ownerScope` is trusted request context, never a public tool field, result field, cursor payload, or error detail.
- Normalize names, aliases, and queries with NFKC, trim, whitespace collapse, and lowercase in the service only.
- Exact ID, exact normalized name, and exact normalized alias resolve only if their active tier has one candidate. Non-empty substring results are always `ambiguous`.
- Cursors are opaque and bound to owner, operation, normalized query, and filters. An unchanged dataset has deterministic duplicate-free pagination; snapshot isolation is not required.
- Project and Session status are the only lifecycle fields. Same-state Session transitions are no-op replays with no timestamp changes.
- Checkpoint IDs are immutable and history is strictly linear. An atomic successful checkpoint write advances the Project head and linked Session head; a replay changes no timestamps.
- Every freshness/resume warning is emitted directly as a complete public object with the existing Project Memory `schema_version`; no adapter may add that field later.
- Project-scoped idempotency receipts retain an internal `projectId` association for cascade deletion only. Lookup and conflict scope remain exactly `(ownerScope, operation, idempotencyKey)`.
- Any inconsistent committed head returns `incomplete`, null checkpoint, and only the generic `repository-state-inconsistent` warning.
- Any result carrying persisted checkpoint-derived content sets `content_trust: "untrusted-persisted-data"`.
- Every behavior starts with a focused failing test, then the smallest implementation, then a focused green run.

---

### Task 1: Align freshness and static tool contracts

**Files:**
- Modify: `noosphere-remote-mcp/contracts/freshness.js`
- Modify: `noosphere-remote-mcp/contracts/mcp-tools.js`
- Modify: `noosphere-remote-mcp/tests/contracts.test.js`

**Interfaces:**
- Produces: `assessResumeFreshness({ latestSessionActivityAt, latestCheckpointAt, sessionStatus })` with `fresh | stale | incomplete`.
- Produces: complete, closed public warnings with `schema_version: PROJECT_MEMORY_SCHEMA_VERSION` and code `interrupted-session | checkpoint-predates-session | no-durable-checkpoint | repository-state-inconsistent`.

- [ ] **Step 1: Write the failing contract test**

```js
it('represents all approved freshness outcomes', () => {
  const cases = [
    assessResumeFreshness({}),
    assessResumeFreshness({ latestCheckpointAt: timestamp, latestSessionActivityAt: later }),
    assessResumeFreshness({ sessionStatus: 'interrupted' }),
    { freshness: 'incomplete', warnings: [{ schema_version: PROJECT_MEMORY_SCHEMA_VERSION, code: 'repository-state-inconsistent', message: 'The durable project state is incomplete and cannot be safely resumed.' }] },
  ];
  const codes = MCP_TOOLS.resume_project.output.properties.warnings.items.properties.code.enum;
  assert.deepEqual(codes, ['interrupted-session', 'checkpoint-predates-session', 'no-durable-checkpoint', 'repository-state-inconsistent']);
  for (const { warnings } of cases) for (const warning of warnings) assert.equal(matchesSchema(MCP_TOOLS.resume_project.output.properties.warnings.items, warning), true);
});
```

- [ ] **Step 2: Run it and confirm RED**

Run: `node --test noosphere-remote-mcp/tests/contracts.test.js --test-name-pattern "represents all approved freshness"`

Expected: FAIL because the current helper emits partial warnings, returns `current`, and the static schema lacks required warnings.

- [ ] **Step 3: Implement the minimum parity change**

```js
export function assessResumeFreshness({ latestSessionActivityAt = null, latestCheckpointAt = null, sessionStatus = null } = {}) {
  const warnings = [];
  const warning = (code, message) => ({ schema_version: PROJECT_MEMORY_SCHEMA_VERSION, code, message });
  if (!latestCheckpointAt) warnings.push(warning('no-durable-checkpoint', 'No durable checkpoint exists for this project.'));
  if (sessionStatus === 'interrupted') warnings.push(warning('interrupted-session', 'The latest session was interrupted; no final handoff is implied.'));
  if (latestCheckpointAt && latestSessionActivityAt > latestCheckpointAt) warnings.push(warning('checkpoint-predates-session', 'Session activity is newer than the latest durable checkpoint.'));
  return { freshness: warnings.some(({ code }) => code === 'no-durable-checkpoint' || code === 'interrupted-session') ? 'incomplete' : warnings.length ? 'stale' : 'fresh', warnings };
}
```

Add the four-code warning enum and change summary `current_status` to nullable text so a project without a checkpoint has a valid summary. Copy the existing closed-schema test matcher from `tests/hardening.test.js` into `tests/contracts.test.js` and use it against `MCP_TOOLS.resume_project.output.properties.warnings.items`. Reuse the same complete warning constructor for `repository-state-inconsistent` in the service and prove all four warning paths validate against the published nested warning schema.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run: `npm --prefix noosphere-remote-mcp test -- --test-name-pattern "freshness"`

Expected: all matching contract tests pass.

- [ ] **Step 5: Commit**

```bash
git add noosphere-remote-mcp/contracts/freshness.js noosphere-remote-mcp/contracts/mcp-tools.js noosphere-remote-mcp/tests/contracts.test.js
git commit -m "fix: align project-memory freshness contracts"
```

### Task 2: Add owner-scoped repository operations and atomic projections

**Files:**
- Modify: `noosphere-remote-mcp/contracts/repository.js`
- Create: `noosphere-remote-mcp/tests/repository-core.test.js`
- Modify: `noosphere-remote-mcp/tests/hardening.test.js`

**Interfaces:**
- Produces: `listProjects`, `replaceProject`, `deleteProject`, `createSession`, `getSession`, `listSessions`, `replaceSession`, `getCheckpoint`, `listCheckpoints`, and `inspectProjectState`, all receiving `ownerScope`.
- Produces: `saveCheckpoint({ ownerScope, checkpoint, idempotency, project, session })`, which atomically writes only pre-projected values and a receipt internally associated with `checkpoint.project_id`.

- [ ] **Step 1: Write failing repository tests**

```js
it('cascades an owner delete without affecting the same ID under another owner', async () => {
  await repository.createProject({ ownerScope: ownerA, project: projectA });
  await repository.createProject({ ownerScope: ownerB, project: projectA });
  await repository.deleteProject({ ownerScope: ownerA, projectId: projectA.id });
  assert.equal(await repository.getProject({ ownerScope: ownerA, projectId: projectA.id }), null);
  assert.ok(await repository.getProject({ ownerScope: ownerB, projectId: projectA.id }));
  await assert.rejects(() => repository.deleteProject({ ownerScope: ownerA, projectId: projectA.id }), /project-not-found/);
});

it('commits checkpoint, Project head, Session head, and receipt together', async () => {
  await repository.saveCheckpoint({ ownerScope: ownerA, checkpoint, project: nextProject, session: nextSession, idempotency });
  assert.equal((await repository.getProject({ ownerScope: ownerA, projectId })).latest_checkpoint_id, checkpoint.id);
  assert.equal((await repository.getSession({ ownerScope: ownerA, projectId, sessionId })).latest_checkpoint_id, checkpoint.id);
});

it('removes only idempotency receipts associated with the deleted owner project', async () => {
  await repository.recordIdempotency({ ownerScope: ownerA, operation: 'save_checkpoint', key: 'same', requestHash: 'a', result: { checkpoint: checkpointA }, projectId: projectA.id });
  await repository.recordIdempotency({ ownerScope: ownerA, operation: 'save_checkpoint', key: 'other', requestHash: 'b', result: { checkpoint: checkpointB }, projectId: projectB.id });
  await repository.recordIdempotency({ ownerScope: ownerB, operation: 'save_checkpoint', key: 'same', requestHash: 'c', result: { checkpoint: checkpointA }, projectId: projectA.id });
  await repository.deleteProject({ ownerScope: ownerA, projectId: projectA.id });
  assert.equal((await repository.recordIdempotency({ ownerScope: ownerA, operation: 'save_checkpoint', key: 'same', requestHash: 'replacement', result: {}, projectId: projectA.id })).deduplicated, false);
  assert.equal((await repository.recordIdempotency({ ownerScope: ownerA, operation: 'save_checkpoint', key: 'other', requestHash: 'b', result: {} })).deduplicated, true);
  assert.equal((await repository.recordIdempotency({ ownerScope: ownerB, operation: 'save_checkpoint', key: 'same', requestHash: 'c', result: {} })).deduplicated, true);
});
```

- [ ] **Step 2: Run it and confirm RED**

Run: `node --test noosphere-remote-mcp/tests/repository-core.test.js`

Expected: FAIL because Sessions, deletion, inspection, and projected atomic saves do not exist.

- [ ] **Step 3: Implement persistence-only operations**

```js
async listProjects({ ownerScope } = {}) {
  assertOwnerScope(ownerScope);
  return [...(this.#projects.get(ownerScope)?.values() ?? [])].map((value) => structuredClone(value));
}

async deleteProject({ ownerScope, projectId } = {}) {
  assertOwnerScope(ownerScope);
  if (!getTuple(this.#projects, [ownerScope, projectId])) throw new Error('project-not-found');
  deleteTuple(this.#projects, [ownerScope, projectId]);
  deleteOwnerProjectRecords(this.#sessions, ownerScope, projectId);
  deleteOwnerProjectRecords(this.#checkpoints, ownerScope, projectId);
  deleteOwnerProjectReceipts(this.#idempotency, ownerScope, projectId);
}
```

Store an optional internal `projectId` with each receipt. `recordIdempotency` keeps the exact existing tuple lookup and conflict behavior; `projectId` is not part of its key and is never returned publicly. `deleteOwnerProjectReceipts` deletes only matching owner/project associations. A failed mutation creates no receipt; matching committed retries replay without timestamp movement. Use nested owner/project/session maps and retain existing collision-safe tuple maps. Validate current heads and every supplied projected record before changing any map. Do not add normalization, matching, clock, or public error logic here.

- [ ] **Step 4: Run repository and hardening tests and confirm GREEN**

Run: `node --test noosphere-remote-mcp/tests/repository-core.test.js noosphere-remote-mcp/tests/hardening.test.js`

Expected: all owner isolation, delete, tuple-boundary, immutable-ID, linear-history, and atomic-projection tests pass.

- [ ] **Step 5: Commit**

```bash
git add noosphere-remote-mcp/contracts/repository.js noosphere-remote-mcp/tests/repository-core.test.js noosphere-remote-mcp/tests/hardening.test.js
git commit -m "feat: extend project-memory repository core"
```

### Task 3: Add pure normalization, cursor, hashing, and error primitives

**Files:**
- Create: `noosphere-remote-mcp/core/normalization.js`
- Create: `noosphere-remote-mcp/core/cursor.js`
- Create: `noosphere-remote-mcp/core/stable-json.js`
- Create: `noosphere-remote-mcp/core/errors.js`
- Create: `noosphere-remote-mcp/tests/core-primitives.test.js`

**Interfaces:**
- Produces: `normalizeProjectText(value)`, `canonicalJson(value)`, `requestHash(value)`, `encodeCursor(value)`, `decodeCursor(cursor, binding)`, and `toPublicError(error)`.

- [ ] **Step 1: Write failing primitive tests**

```js
it('uses NFKC, trim, whitespace collapse, and lowercase', () => {
  assert.equal(normalizeProjectText('  Ｂicycle\tRepair  '), 'bicycle repair');
});

it('rejects a cursor reused by another owner or query', () => {
  const cursor = encodeCursor({ ownerScope: ownerA, operation: 'list_projects', query: { includeArchived: false }, after: 'prj_b' });
  assert.equal(decodeCursor(cursor, { ownerScope: ownerA, operation: 'list_projects', query: { includeArchived: false } }).after, 'prj_b');
  assert.throws(() => decodeCursor(cursor, { ownerScope: ownerB, operation: 'list_projects', query: { includeArchived: false } }), /invalid-cursor/);
});
```

- [ ] **Step 2: Run it and confirm RED**

Run: `node --test noosphere-remote-mcp/tests/core-primitives.test.js`

Expected: FAIL because the core primitive modules are absent.

- [ ] **Step 3: Implement deterministic primitives**

```js
export function normalizeProjectText(value) {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

export function requestHash(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}
```

Canonical JSON recursively sorts object keys and preserves array order. Cursor encoding serializes owner/operation/query/after as Base64URL; decoding requires exact canonical binding equality and rejects malformed values. Public error mapping returns only existing structured error envelopes and maps unknown internal errors to generic `internal`.

- [ ] **Step 4: Run it and confirm GREEN**

Run: `node --test noosphere-remote-mcp/tests/core-primitives.test.js`

Expected: all normalization, cursor-binding, hash determinism, and redaction tests pass.

- [ ] **Step 5: Commit**

```bash
git add noosphere-remote-mcp/core noosphere-remote-mcp/tests/core-primitives.test.js
git commit -m "feat: add project-memory core primitives"
```

### Task 4: Implement project lifecycle, matching, and pagination commands

**Files:**
- Create: `noosphere-remote-mcp/core/project-memory-service.js`
- Modify: `noosphere-remote-mcp/index.js`
- Create: `noosphere-remote-mcp/tests/project-memory-service.test.js`

**Interfaces:**
- Produces: `new ProjectMemoryService({ repository, now, nextId })`.
- Produces: `createProject`, `getProject`, `listProjects`, `findProjects`, `updateProject`, `archiveProject`, and `deleteProject`, each accepting `{ ownerScope, input }`.

- [ ] **Step 1: Write failing service tests**

```js
it('returns ambiguity for a single substring candidate', async () => {
  await service.createProject({ ownerScope: ownerA, input: { name: 'Bicycle Repair' } });
  assert.deepEqual(await service.findProjects({ ownerScope: ownerA, input: { query: 'bicy' } }), {
    result: 'ambiguous', candidates: [projectRef('Bicycle Repair')],
  });
});

it('resolves one exact alias but excludes archived matches', async () => {
  const project = await service.createProject({ ownerScope: ownerA, input: { name: 'Bicycle Repair', aliases: ['bike'] } });
  assert.equal((await service.findProjects({ ownerScope: ownerA, input: { query: 'ＢＩＫＥ' } })).result, 'resolved');
  await service.archiveProject({ ownerScope: ownerA, input: { project_id: project.id } });
  assert.deepEqual(await service.findProjects({ ownerScope: ownerA, input: { query: 'bike' } }), { result: 'none', candidates: [] });
});
```

- [ ] **Step 2: Run it and confirm RED**

Run: `node --test noosphere-remote-mcp/tests/project-memory-service.test.js --test-name-pattern "substring|exact alias"`

Expected: FAIL because `ProjectMemoryService` is not exported.

- [ ] **Step 3: Implement project service behavior**

```js
async findProjects({ ownerScope, input }) {
  const query = normalizeProjectText(assertQuery(input));
  const active = (await this.#repository.listProjects({ ownerScope })).filter(({ status }) => status !== 'archived');
  for (const matches of [
    active.filter(({ id }) => id === input.query),
    active.filter(({ normalized_name }) => normalized_name === query),
    active.filter(({ aliases }) => aliases.some((alias) => normalizeProjectText(alias) === query)),
  ]) {
    if (matches.length === 1) return { result: 'resolved', project: matches[0] };
    if (matches.length > 1) return { result: 'ambiguous', candidates: orderProjectRefs(matches, input.limit) };
  }
  const partial = active.filter((project) => project.normalized_name.includes(query) || project.aliases.some((alias) => normalizeProjectText(alias).includes(query)));
  return partial.length ? { result: 'ambiguous', candidates: orderProjectRefs(partial, input.limit) } : { result: 'none', candidates: [] };
}
```

Build Project timestamps and normalized fields only in this service. Lists sort by `last_activity_at` descending then ID ascending and use Task 3 owner/query-bound cursors. Delete maps missing or cross-owner records to the same public `not-found` result.

- [ ] **Step 4: Run service tests and confirm GREEN**

Run: `node --test noosphere-remote-mcp/tests/project-memory-service.test.js`

Expected: all exact-tier, partial-search, owner isolation, archive/delete, timestamp, and cursor tests pass.

- [ ] **Step 5: Commit**

```bash
git add noosphere-remote-mcp/core/project-memory-service.js noosphere-remote-mcp/index.js noosphere-remote-mcp/tests/project-memory-service.test.js
git commit -m "feat: add project-memory project core"
```

### Task 5: Implement Session, checkpoint, resume, and summary commands

**Files:**
- Modify: `noosphere-remote-mcp/core/project-memory-service.js`
- Modify: `noosphere-remote-mcp/index.js`
- Modify: `noosphere-remote-mcp/tests/project-memory-service.test.js`
- Create: `noosphere-remote-mcp/tests/resume-project.test.js`

**Interfaces:**
- Produces: `createSession`, `getSession`, `listProjectSessions`, `transitionSession`, `saveCheckpoint`, `getLatestCheckpoint`, `getCheckpoint`, `listCheckpoints`, `resumeProject`, and `getProjectSummary`.

- [ ] **Step 1: Write failing state-machine and resume tests**

```js
it('keeps timestamps unchanged for a same-state Session request', async () => {
  const session = await service.createSession({ ownerScope: ownerA, input: sessionInput });
  const repeated = await service.transitionSession({ ownerScope: ownerA, input: { project_id: session.project_id, session_id: session.id, status: 'active' } });
  assert.equal(repeated.updated_at, session.updated_at);
});

it('returns generic incomplete resume for a mismatched committed head', async () => {
  await seedCommittedProject({ service, ownerScope: ownerA });
  await repository.replaceProject({ ownerScope: ownerA, projectId, project: { ...project, latest_checkpoint_id: 'chk_missing' } });
  const result = await service.resumeProject({ ownerScope: ownerA, input: { project_id: projectId } });
  assert.equal(result.project.id, projectId);
  assert.equal(result.latest_checkpoint, null);
  assert.equal(result.freshness, 'incomplete');
  assert.deepEqual(result.warnings, [{ code: 'repository-state-inconsistent', message: 'The durable project state is incomplete and cannot be safely resumed.' }]);
  assert.equal(result.content_trust, 'untrusted-persisted-data');
});
```

- [ ] **Step 2: Run it and confirm RED**

Run: `node --test noosphere-remote-mcp/tests/project-memory-service.test.js noosphere-remote-mcp/tests/resume-project.test.js`

Expected: FAIL because Session, checkpoint, resume, and summary methods do not exist.

- [ ] **Step 3: Implement the approved lifecycle and consistency projection**

```js
const TRANSITIONS = Object.freeze({
  active: new Set(['paused', 'interrupted', 'completed', 'archived']),
  paused: new Set(['active', 'interrupted', 'completed', 'archived']),
  interrupted: new Set(['active', 'completed', 'archived']),
  completed: new Set(['archived']),
  archived: new Set(),
});

function inconsistentResume() {
  return {
    latest_checkpoint: null,
    freshness: 'incomplete',
    warnings: [{ code: 'repository-state-inconsistent', message: 'The durable project state is incomplete and cannot be safely resumed.' }],
    content_trust: 'untrusted-persisted-data',
  };
}
```

Derive checkpoint revision/predecessor from the committed Project head and derive request hash from canonical public save input. Reject cross-project Sessions before persistence. Inspect all committed checkpoints/Sessions before computing freshness: Project head must be highest revision in owner/project; non-null Session heads must exist in owner/project; the Session linked by Project head must point to that head; later non-interrupted activity is stale. Every checkpoint-derived response includes the trust marker.

- [ ] **Step 4: Run it and confirm GREEN**

Run: `node --test noosphere-remote-mcp/tests/project-memory-service.test.js noosphere-remote-mcp/tests/resume-project.test.js`

Expected: all Session transitions, idempotency replay, linear checkpoint, head consistency, fresh/stale/incomplete, and trust-boundary tests pass.

- [ ] **Step 5: Commit**

```bash
git add noosphere-remote-mcp/core/project-memory-service.js noosphere-remote-mcp/index.js noosphere-remote-mcp/tests/project-memory-service.test.js noosphere-remote-mcp/tests/resume-project.test.js
git commit -m "feat: add project-memory session and resume core"
```

### Task 6: Prove end-to-end core behavior and PR scope containment

**Files:**
- Modify: `noosphere-remote-mcp/tests/project-memory-service.test.js` only if the acceptance regression exposes a defect.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: evidence that Bicycle Repair resumes from persisted state without selecting or exposing ESS Design.

- [ ] **Step 1: Add the failing acceptance regression**

```js
it('resumes Bicycle Repair without selecting ESS Design', async () => {
  const bicycle = await service.createProject({ ownerScope: ownerA, input: { name: 'Bicycle Repair' } });
  const ess = await service.createProject({ ownerScope: ownerA, input: { name: 'ESS Design' } });
  await service.saveCheckpoint({ ownerScope: ownerA, input: bicycleCheckpointInput(bicycle.id) });
  assert.equal((await service.resumeProject({ ownerScope: ownerA, input: { project_id: bicycle.id } })).latest_checkpoint.project_id, bicycle.id);
  assert.equal((await service.findProjects({ ownerScope: ownerA, input: { query: 'design' } })).result, 'ambiguous');
  assert.notEqual(bicycle.id, ess.id);
});
```

- [ ] **Step 2: Run it and confirm the expected state**

Run: `node --test noosphere-remote-mcp/tests/project-memory-service.test.js --test-name-pattern "resumes Bicycle Repair"`

Expected: PASS after Tasks 1–5; a failure must receive the smallest test-first repair before verification continues.

- [ ] **Step 3: Run Project Memory verification**

Run: `npm --prefix noosphere-remote-mcp test`

Expected: all Project Memory checks and all contract, hardening, repository, primitive, service, and resume tests pass.

- [ ] **Step 4: Run existing compatibility and packaging gates**

Run:

```bash
npm --prefix noosphere-acp-protocol test
npm --prefix noosphere-relayer run check
npm --prefix noosphere-relayer test
npm --prefix noosphere-mcp pack --dry-run
npm --prefix noosphere-relayer pack --dry-run
git diff --check origin/main...HEAD
git diff --name-status origin/main...HEAD
git status --short
```

Expected: existing suites retain their observed baseline results; existing package dry-runs include no `noosphere-remote-mcp` files; diff check is clean; no file outside Project Memory code/tests/docs changed.

- [ ] **Step 5: Commit only an acceptance-test repair if one was required**

```bash
git add noosphere-remote-mcp/tests/project-memory-service.test.js
git commit -m "test: cover project-memory continuity core"
```

Skip this command when Step 2 passes without a source change.
