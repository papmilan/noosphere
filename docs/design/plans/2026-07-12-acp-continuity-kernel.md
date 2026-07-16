# ACP Continuity Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a validated, Git-bound ACP Project State Envelope and a deterministic compact continuity kernel to Noosphere.

**Architecture:** JSON is an untrusted WireEnvelope. ACP decodes it into immutable `ProjectState`, then applies pure validation, Git compatibility, merge, and rendering functions using explicit clock, policy, and repository inputs. The CLI persists canonical JSON and its derived Markdown projection atomically.

**Tech Stack:** Node.js 22 ESM, `node:test`, Node crypto/fs/child-process APIs, Git CLI, JSON Schema.

## Global Constraints

- Store externally shareable project state only; never hidden reasoning, token traces, secrets, credentials, raw chat, or provider session state.
- Parsed JSON never reaches merge/render code; all domain operations consume `ProjectState`.
- Equal explicit inputs produce byte-identical errors, conflicts, canonical JSON, and Markdown. No implicit time, random, locale, network, or model calls.
- V1 retains only the current snapshot. A stale update merges only append-only distinct-ID assertions; all competing edits become explicit conflicts.
- `.noosphere/continuity.json` is canonical generated state; `.noosphere/continuity.md` is a derived projection at most 1,800 UTF-8 bytes.
- Preserve baseline, context, journal, master-prompt, follow-up, checkpoint, local-file, and Walrus workflows.

## File Structure

| File | Responsibility |
| --- | --- |
| `noosphere-mcp/continuity/acp/schema.json` | Portable ACP v1 WireEnvelope schema. |
| `noosphere-mcp/continuity/acp/project-state.js` | Immutable state, invariants, active-item indexes. |
| `noosphere-mcp/continuity/acp/wire.js` | Parsing, RFC 8785-style canonicalization, digest, encoding. |
| `noosphere-mcp/continuity/acp/git-state.js` | Repository observation and compatibility classification. |
| `noosphere-mcp/continuity/acp/merge.js` | Conservative update and conflict creation. |
| `noosphere-mcp/continuity/acp/render.js` | Bounded deterministic kernel. |
| `noosphere-mcp/continuity/acp/store.js` | Atomic persistence and validation. |
| `noosphere-mcp/continuity/index.js` | Commands, initialization, instructions, help. |
| `noosphere-mcp/tests/acp-*.test.js` | ACP unit, integration, and continuation tests. |

## Shared Interfaces

```js
export const ACP_PROTOCOL = 'acp.project-state-envelope';
export const ACP_SCHEMA_VERSION = '1.0.0';
export function decodeEnvelope(input, options = {}) {}
export function encodeEnvelope(state) {}
export function observeRepository(root) {}
export function classifyCompatibility(state, observedRepository) {}
export function applyUpdate(state, update, inputs) {}
export function renderKernel(state, inputs) {}
export function readState(root, options = {}) {}
export function writeState(root, state, options = {}) {}
```

`decodeEnvelope` and `applyUpdate` return `{ ok: true, state }` or `{ ok: false, errors: [{ path, code, message }] }`.

### Task 1: Schema and immutable runtime ProjectState

**Files:** Create `noosphere-mcp/continuity/acp/schema.json`, `noosphere-mcp/continuity/acp/project-state.js`, and `noosphere-mcp/tests/acp-project-state.test.js`; modify `noosphere-mcp/package.json`.

**Interfaces:** Produces `createProjectState(envelope, { clock, policy })`, `ACP_PROTOCOL`, and `ACP_SCHEMA_VERSION`.

- [ ] **Step 1: Write the failing invariant tests**

```js
it('rejects duplicate assertion IDs', () => {
  const input = validEnvelope({
    references: [{ id: 'r1', kind: 'file', locator: 'README.md' }],
    decisions: [decision('d1', 'SQLite'), decision('d1', 'Postgres')],
  });
  const result = createProjectState(input, { clock: input.created_at });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'duplicate-id');
});
```

Add a second test with two active `storage` decisions and assert that runtime conflicts contains `{ kind: 'decision-domain', status: 'unresolved' }`.

- [ ] **Step 2: Verify the test fails**

Run: `npm --prefix noosphere-mcp exec -- node --test tests/acp-project-state.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `continuity/acp/project-state.js`.

- [ ] **Step 3: Implement the schema and constructor**

Use Draft 2020-12, `additionalProperties: false`, bounded fields, ADR enums, and namespaced extension keys. Implement this boundary:

```js
export function createProjectState(envelope, { clock, policy = defaultPolicy } = {}) {
  const errors = validateEnvelope(envelope, policy);
  if (errors.length) return { ok: false, errors: orderErrors(errors) };
  const normalized = normalizeEnvelope(envelope);
  const runtime = buildIndexes(normalized, clock);
  if (runtime.errors.length) return { ok: false, errors: orderErrors(runtime.errors) };
  return { ok: true, state: Object.freeze({ envelope: deepFreeze(normalized), runtime: deepFreeze(runtime.value) }) };
}
```

Reject forbidden nested keys, self-supersession, dangling provenance, invalid timestamps, and oversized text. Build `byId`, `referencesById`, `activeByType`, `activeDecisionsByDomain`, and unresolved conflicts.

- [ ] **Step 4: Verify green and commit**

Add expiry, immutability, and stable conflict-order tests. Run `npm --prefix noosphere-mcp exec -- node --test tests/acp-project-state.test.js`; expected PASS. Add the new source to the `check` script, run `npm --prefix noosphere-mcp run check`; expected PASS. Commit only the Task 1 files with message `feat: add ACP project state invariants`.

### Task 2: Canonical wire envelopes

**Files:** Create `noosphere-mcp/continuity/acp/wire.js` and `noosphere-mcp/tests/acp-wire.test.js`; modify `noosphere-mcp/package.json`.

**Interfaces:** Consumes ProjectState; produces `decodeEnvelope`, `encodeEnvelope`, `canonicalize`, and `digestEnvelope`.

- [ ] **Step 1: Write failing canonicalization tests**

```js
it('sorts object keys but preserves declared array order', () => {
  assert.equal(canonicalize({ z: 1, a: ['second', 'first'] }), '{"a":["second","first"],"z":1}');
});

it('rejects a mismatched digest', () => {
  const input = validEnvelope();
  input.snapshot_id = 'sha256:wrong';
  input.integrity.digest = 'wrong';
  assert.equal(decodeEnvelope(input, { clock: input.created_at }).errors[0].code, 'digest-mismatch');
});
```

- [ ] **Step 2: Verify red, then implement**

Run: `npm --prefix noosphere-mcp exec -- node --test tests/acp-wire.test.js`; expected missing-module failure. Implement a pure canonical serializer with NFC/LF normalization, sorted object keys, preserved array order, finite-number rejection, and SHA-256 UTF-8 digest input that removes `snapshot_id`, `integrity.digest`, and `integrity.signature.value`. `encodeEnvelope` deep-clones and recomputes digest/ID without runtime indexes.

- [ ] **Step 3: Verify green and commit**

Add CRLF, Unicode composition, insertion-order, malformed-JSON, and signature-exclusion tests. Run `npm --prefix noosphere-mcp exec -- node --test tests/acp-wire.test.js tests/acp-project-state.test.js`; expected PASS. Add syntax checking and commit Task 2 files with message `feat: add canonical ACP wire envelopes`.

### Task 3: Git compatibility

**Files:** Create `noosphere-mcp/continuity/acp/git-state.js` and `noosphere-mcp/tests/acp-git-state.test.js`; modify `noosphere-mcp/continuity/index.js` and package checks.

**Interfaces:** Produces `observeRepository(root)` and `classifyCompatibility(state, observedRepository)`.

- [ ] **Step 1: Write failing Git-fixture tests**

```js
it('marks a matching checkout exact', async () => {
  const observed = await observeRepository(projectDir);
  assert.deepEqual(classifyCompatibility(stateFor(observed), observed), {
    status: 'exact', trustDowngrade: 0, actionable: true, reasons: [],
  });
});
```

Use temporary repositories as in `tests/continuity.test.js`. Add foreign identity, descendant HEAD, diverged branch, ignored `.noosphere` change, and unborn repository cases.

- [ ] **Step 2: Verify red, then implement**

Run: `npm --prefix noosphere-mcp exec -- node --test tests/acp-git-state.test.js`; expected missing-module failure. Extract the existing fingerprint helper from `index.js`. Observe root identity, HEAD, branch, dirty state, and fingerprint without mutation. Return `exact`, `compatible`, `advanced`, `diverged`, `foreign`, or `unknown` with stable reasons; only exact/compatible/advanced are actionable.

- [ ] **Step 3: Verify green and commit**

Run `npm --prefix noosphere-mcp exec -- node --test tests/acp-git-state.test.js tests/continuity.test.js`; expected PASS. Add syntax check and commit Task 3 files with message `feat: classify ACP repository freshness`.

### Task 4: Conservative merge and bounded kernel

**Files:** Create `noosphere-mcp/continuity/acp/merge.js`, `continuity/acp/render.js`, `tests/acp-merge.test.js`, and `tests/acp-render.test.js`; modify package checks.

**Interfaces:** Consumes ProjectState/wire/compatibility; produces `applyUpdate` and `renderKernel`.

- [ ] **Step 1: Write failing safety tests**

```js
it('does not choose between stale competing decisions', () => {
  const result = applyUpdate(currentState, staleUpdate('Postgres'), inputs);
  assert.equal(result.ok, true);
  assert.equal(result.conflicts[0].kind, 'decision-domain');
});

it('keeps conflict and blocker within the kernel budget', () => {
  const output = renderKernel(conflictedState, { compatibility: exactCompatibility });
  assert.ok(Buffer.byteLength(output, 'utf8') <= 1800);
  assert.match(output, /UNRESOLVED CONFLICT/);
  assert.match(output, /BLOCKER/);
});
```

- [ ] **Step 2: Verify red, then implement**

Run: `npm --prefix noosphere-mcp exec -- node --test tests/acp-merge.test.js tests/acp-render.test.js`; expected missing-module failure. Matching parents may replace validated fields. Stale updates union only new distinct-ID append-only items. Existing-ID changes, deletion, same-domain decisions, and competing priority-1 actions append ordered unresolved conflicts.

Render complete sections in this order: compatibility, objective/phase, high-impact conflicts, blockers, risks, decisions, stance, top next action, references. Add a section only if all bytes fit. If mandatory content overflows, render exactly:

```text
# ACP CONTINUITY KERNEL
Status: unsafe-to-summarize
Reason: mandatory ACP conflicts or blockers exceed the safe kernel budget.
Next: run `noosphere state --json` and resolve the listed conflicts before acting.
```

- [ ] **Step 3: Verify green and commit**

Add stale append-only, delete-vs-modify, priority conflict, repeated-byte equality, and no-mid-item-truncation tests. Run focused tests; expected PASS. Add syntax checks and commit Task 4 files with message `feat: add ACP conflict-safe handoffs`.

### Task 5: Atomic storage, initialization, and CLI

**Files:** Create `noosphere-mcp/continuity/acp/store.js` and `tests/acp-store.test.js`; modify `continuity/index.js`, `tests/continuity.test.js`, and package checks.

**Interfaces:** Consumes ACP modules; produces `readState`, `writeState`, `validateState`, plus `noosphere handoff` and `noosphere state`.

- [ ] **Step 1: Write failing integration tests**

```js
it('writes matching canonical JSON and Markdown', async () => {
  await writeState(projectDir, state, inputs);
  const envelope = JSON.parse(await readFile(jsonFile, 'utf8'));
  const kernel = await readFile(markdownFile, 'utf8');
  assert.match(kernel, new RegExp(envelope.snapshot_id));
});

it('imports a structured handoff through the CLI', async () => {
  await writeFile(candidateFile, JSON.stringify(validUpdate));
  const result = await runCli(['handoff', '--file', candidateFile]);
  assert.match(result.stdout, /ACP handoff stored/);
});
```

- [ ] **Step 2: Verify red, then implement**

Run: `npm --prefix noosphere-mcp exec -- node --test tests/acp-store.test.js tests/continuity.test.js --test-name-pattern="ACP"`; expected failure because ACP persistence/commands do not exist. Write JSON and Markdown to temporary files, rename JSON then Markdown, and leave existing files unchanged on error. Initialize from observable Git facts and references without inferring goals. Exclude both generated files.

Add `handoff --file <path>` and `handoff --stdin` (exactly one source), `state`, `state --json`, and `state validate`. V1 does not upload ACP content. `state validate` fails for digest/schema/kernel mismatch and foreign compatibility. Update generated adapters to load prompt/follow-ups, then kernel, then Git, then large context.

- [ ] **Step 3: Verify green and commit**

Run `npm --prefix noosphere-mcp test`; expected PASS. Commit Task 5 files with message `feat: expose ACP continuity kernels`.

### Task 6: Documentation and continuation fixture

**Files:** Create `noosphere-mcp/tests/fixtures/acp/continuation-case.json` and `tests/acp-continuation.test.js`; modify `README.md` and `noosphere-mcp/README.md`.

**Interfaces:** Consumes wire/render modules; produces a repeatable continuation acceptance case.

- [ ] **Step 1: Write the failing continuation test**

```js
it('preserves continuation-critical fields in the kernel', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const state = decodeEnvelope(fixture.envelope, { clock: fixture.clock }).state;
  const kernel = renderKernel(state, fixture.render_options);
  for (const fragment of fixture.required_kernel_fragments) assert.match(kernel, new RegExp(fragment));
  assert.ok(Buffer.byteLength(kernel, 'utf8') <= 1800);
});
```

- [ ] **Step 2: Verify red, then implement docs and fixture**

Run: `npm --prefix noosphere-mcp exec -- node --test tests/acp-continuation.test.js`; expected missing-fixture failure. Document `state`, `state --json`, `state validate`, `handoff --file`, and `handoff --stdin`; describe local-first scope, privacy boundary, and conflict behavior. The fixture contains an objective, protected constraint, evidenced decision, low-confidence assumption, unresolved conflict, and priority-1 action.

- [ ] **Step 3: Full verification and commit**

Run: `npm --prefix noosphere-mcp run check && npm --prefix noosphere-relayer run check && npm --prefix noosphere-relayer test && git diff --check`

Expected: all commands PASS and `git diff --check` prints nothing. Commit Task 6 files with message `docs: document ACP continuity kernel`, then append a concise verification handoff to `.noosphere/journal.md`.

## Plan Self-Review

- Tasks 1–2 implement the wire/domain boundary and determinism mandated by ADR 0001.
- Task 3 implements Git safety; Task 4 implements conflict safety and compact rendering.
- Task 5 provides persistence, migration, commands, and agent startup behavior.
- Task 6 supplies public documentation and a repeatable continuation fixture.
- All interfaces used by later tasks are declared above; no task depends on remote ACP storage, automatic extraction, or hidden model reasoning.
