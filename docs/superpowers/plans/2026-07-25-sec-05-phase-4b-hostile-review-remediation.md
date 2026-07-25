# SEC-05 Phase 4B Hostile-Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the Phase 4B exact-head review Blockers while preserving the interactive-only approval boundary and format-1 compatibility policy.

**Architecture:** Keep the current approval service and dispatcher boundaries. Strengthen the shared source resolver to retain exact bytes, make the approval display byte-faithful and side-effect-free until confirmation, and make binding selection tri-state so only true absence can select format 1.

**Tech Stack:** Node.js 22 ESM, `node:test`, owner-only SEC-05 filesystem primitives, npm package export maps, POSIX `script` for genuine PTY coverage.

## Global Constraints

- Base implementation is `e3bb7b5` on `codex/sec-05-phase-4b`; the design-only checkpoint is `37bc5ae`.
- Do not implement Phase 4C migration, revocation, restore, tombstones, or identity switching.
- Do not add a noninteractive approval flag, environment variable, config switch, API, or MCP tool.
- Successful authority creation still requires TTY stdin and stdout plus the exact phrase `approve <slot> <rawHash[0:8]>`.
- Only true `ENOENT` at the binding path may select format-1 fallback.
- Invalid UTF-8 source files fail before confirmation and before trust-store mutation.
- Windows keeps the existing documented reduced directory-entry durability; the POSIX PTY harness is explicitly skipped there.

---

### Task 1: Exact source bytes and byte-faithful terminal representation

**Files:**
- Modify: `noosphere-mcp/continuity/slot-sources.js`
- Modify: `noosphere-mcp/continuity/internal/approval-service.js`
- Modify: `noosphere-mcp/continuity/index.js`
- Modify: `noosphere-mcp/tests/trust-approval.test.js`

**Interfaces:**
- Produces: `resolveSlotSource(root, slot) -> Promise<{ bytes: Buffer, text: string }>`
- Produces: `escapeBytesForTerminal(bytes) -> string`
- Preserves: `resolveSlotBytes(root, slot) -> Promise<string>` as a delegating compatibility helper.

- [ ] **Step 1: Add failing invalid-UTF-8 and display tests**

Add tests which write two distinct malformed byte strings and assert both
`resolveSlotSource` and approval reject with `slot-invalid-utf8`. Add a display
test that captures confirmation details and asserts:

```js
assert.equal(shown.rawHash, sha256(sourceBytes));
assert.equal(shown.escapedBytes, 'line\\x09one\\x0a\\xe2\\x80\\xae');
assert.ok(!shown.escapedBytes.includes(ESC));
assert.ok(!hasBidiOverride(shown.escapedBytes));
```

Also assert `Buffer.from(shown.text, 'utf8')` equals the retained valid source
bytes for master-prompt and instructions, and the derived baseline body bytes for
baseline.

- [ ] **Step 2: Run the new tests and verify RED**

Run:

```sh
node --test --test-concurrency=1 tests/trust-approval.test.js
```

Expected: FAIL because malformed UTF-8 is currently decoded to U+FFFD and
`escapedBytes`/`resolveSlotSource` do not exist.

- [ ] **Step 3: Implement the raw source boundary**

In `slot-sources.js`, read a `Buffer`, decode with a fatal decoder, and encode the
single derived text:

```js
const UTF8 = new TextDecoder('utf-8', { fatal: true });

export async function resolveSlotSource(root, slot) {
  const segments = SLOT_FILES[slot];
  if (!segments) return { bytes: Buffer.alloc(0), text: '' };
  const fileBytes = await readFile(path.join(root, ...segments)).catch((error) => {
    if (error.code === 'ENOENT') return Buffer.alloc(0);
    throw error;
  });
  let fileText;
  try {
    fileText = UTF8.decode(fileBytes);
  } catch {
    const error = new Error(`${slot} is not valid UTF-8`);
    error.code = 'slot-invalid-utf8';
    throw error;
  }
  const text = slot === 'baseline' ? baselineBody(fileText) : fileText;
  return { bytes: Buffer.from(text, 'utf8'), text };
}

export async function resolveSlotBytes(root, slot) {
  return (await resolveSlotSource(root, slot)).text;
}
```

In `approval-service.js`, derive once with `resolveSlotSource`, retain its
`Buffer`, and add:

```js
export function escapeBytesForTerminal(value) {
  return [...Buffer.from(value)].map((byte) =>
    byte >= 0x20 && byte <= 0x7e && byte !== 0x5c
      ? String.fromCharCode(byte)
      : `\\x${byte.toString(16).padStart(2, '0')}`
  ).join('');
}
```

Pass `escapedBytes` and an escaped `sourcePath` to the confirmation renderer.
Label the escaped bytes separately from `rendered`, which remains the normalized
sink view. Keep `rawHash` over the retained `Buffer`.

- [ ] **Step 4: Route sink reads through the shared resolver**

Use `resolveSlotSource` for local baseline/master-prompt/instructions reads where
the sink controls the source read. Where restore fallback supplies a remote
string, derive its bytes once with `Buffer.from(text, 'utf8')` and gate/render
that same value. Do not independently strip or normalize a slot outside
`slot-sources.js`.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```sh
node --test --test-concurrency=1 tests/trust-approval.test.js tests/adapter-injection.test.js
```

Expected: all subtests PASS.

- [ ] **Step 6: Commit Task 1**

```sh
git add noosphere-mcp/continuity/slot-sources.js \
  noosphere-mcp/continuity/internal/approval-service.js \
  noosphere-mcp/continuity/index.js \
  noosphere-mcp/tests/trust-approval.test.js
git commit -m "security(SEC-05): preserve exact approval source bytes"
```

### Task 2: Exact confirmation and zero pre-confirmation trust state

**Files:**
- Modify: `noosphere-mcp/continuity/internal/approval-service.js`
- Modify: `noosphere-mcp/tests/trust-approval.test.js`
- Modify: `noosphere-mcp/tests/trust-approval-cli.test.js`

**Interfaces:**
- Produces: `MAX_CONFIRMATION_BYTES` internal constant.
- Preserves: `approveSlot(options) -> Promise<{ record, audit, manifest }>`

- [ ] **Step 1: Add failing phrase and state-order tests**

Add table-driven default-confirm tests for leading/trailing spaces, tabs,
uppercase, suffixes, empty input, EOF, and an input larger than the bound. Each
must reject and leave `NOOSPHERE_HOME` absent. Strengthen decline assertions to:

```js
await assert.rejects(fs.lstat(home), (error) => error.code === 'ENOENT');
```

Use a parent directory plus a not-yet-created `NOOSPHERE_HOME` so the assertion
proves the machine key, binding, lock, and directories were never created.

- [ ] **Step 2: Run the new tests and verify RED**

Run:

```sh
node --test --test-concurrency=1 tests/trust-approval.test.js tests/trust-approval-cli.test.js
```

Expected: FAIL because `answer.trim()` accepts surrounding whitespace and
binding/recovery state is created before confirmation.

- [ ] **Step 3: Make confirmation exact and bounded**

Replace the phrase comparison with:

```js
return answer === phrase;
```

Track input bytes while the question is active. Abort the question and throw
`TrustStoreError('approval-input-too-long', ...)` once the configured fixed
bound is exceeded. Treat EOF and abort as refusal; do not retry.

- [ ] **Step 4: Move every store side effect after confirmation**

Keep validation, TTY assertion, source derivation, hashes, display, and phrase
read before store construction. Only after `approved === true` execute:

```js
const store = createFormatV2Store({ env, secureFileOptions, now });
const binding = await store.createProjectBinding(projectRoot);
await store.recover(binding, slot);
return store.commitTransaction({
  binding,
  slot,
  rawBytes: bytes,
  sourceOrigin: `cli:trust-approve:${slot}`,
});
```

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```sh
node --test --test-concurrency=1 tests/trust-approval.test.js tests/trust-approval-cli.test.js
```

Expected: all subtests PASS and no test leaves trust state on refusal.

- [ ] **Step 6: Commit Task 2**

```sh
git add noosphere-mcp/continuity/internal/approval-service.js \
  noosphere-mcp/tests/trust-approval.test.js \
  noosphere-mcp/tests/trust-approval-cli.test.js
git commit -m "security(SEC-05): make confirmation exact and side-effect free"
```

### Task 3: Fail-closed format selection and exact CLI grammar

**Files:**
- Modify: `noosphere-mcp/continuity/trust-store.js`
- Modify: `noosphere-mcp/continuity/index.js`
- Modify: `noosphere-mcp/tests/trust-approval.test.js`
- Modify: `noosphere-mcp/tests/trust-approval-cli.test.js`

**Interfaces:**
- Preserves: `isSlotAuthoritative(request) -> Promise<boolean>`
- Changes internal CLI handler to `trustFromCli(root, args: string[])`.

- [ ] **Step 1: Add failing binding downgrade tests**

Seed valid format-2 and stale format-1 authority, then replace the binding with:

```js
await fs.symlink('/dev/null', bindingFile);
await fs.mkdir(bindingFile);
```

in separate fixtures. Assert stale format-1 bytes remain non-authoritative.
Inject a secure-file option or permission failure that makes the binding lookup
throw a non-`ENOENT` error and assert fail-closed `false`.

- [ ] **Step 2: Add failing CLI grammar and exit-status tests**

Drive the real CLI and assert rejection before TTY handling for:

```text
trust approve
trust approve master-prompt extra
trust approve --yes master-prompt
trust approve master-prompt --yes
trust approve -- master-prompt
trust approve MASTER-PROMPT
```

Reserve exit status `2` for usage/slot errors, `3` for owner refusal/TTY refusal,
and `1` for internal failures.

- [ ] **Step 3: Run the tests and verify RED**

Run:

```sh
node --test --test-concurrency=1 tests/trust-approval.test.js tests/trust-approval-cli.test.js
```

Expected: FAIL because symlink/directory bindings fall back and the CLI ignores
arguments after the slot.

- [ ] **Step 4: Implement tri-state binding selection**

Replace the boolean regular-file probe with:

```js
let bindingAbsent = false;
try {
  await fs.lstat(store.bindingPath(projectRoot));
} catch (error) {
  if (error.code === 'ENOENT') bindingAbsent = true;
  else return false;
}
if (!bindingAbsent) {
  try {
    const binding = await store.readProjectBinding(projectRoot);
    const manifest = await store.readManifest(binding, slot);
    if (manifest) return store.isFormat2Authoritative({ binding, slot, rawBytes });
  } catch {
    return false;
  }
}
```

Only the `bindingAbsent` branch may call format 1.

- [ ] **Step 5: Implement exact CLI argument parsing and statuses**

Pass `process.argv.slice(3)` to `trustFromCli`. Remove exactly one
`--path <value>` pair already consumed by the global parser, then require exactly
two remaining tokens: `approve` and one approvable slot. Throw a small CLI error
carrying `exitCode = 2` for grammar/slot failures. Map
`approval-requires-tty`, `approval-declined`, `approval-input-too-long`, and
invalid UTF-8 owner refusal to `exitCode = 3`; retain `1` for unexpected failures.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```sh
node --test --test-concurrency=1 tests/trust-approval.test.js tests/trust-approval-cli.test.js
```

Expected: all subtests PASS.

- [ ] **Step 7: Commit Task 3**

```sh
git add noosphere-mcp/continuity/trust-store.js \
  noosphere-mcp/continuity/index.js \
  noosphere-mcp/tests/trust-approval.test.js \
  noosphere-mcp/tests/trust-approval-cli.test.js
git commit -m "security(SEC-05): fail closed on every format-2 binding state"
```

### Task 4: Genuine PTY success, documentation, and whole-branch verification

**Files:**
- Modify: `noosphere-mcp/tests/trust-approval-cli.test.js`
- Modify: `SECURITY.md`
- Modify: `SEC-05-PHASE-4B-PLAN.md`
- Modify: `noosphere-mcp/package.json` only if a new test helper requires a syntax check.

**Interfaces:**
- No production API changes.

- [ ] **Step 1: Add a genuine PTY end-to-end test**

On Linux, run the CLI through:

```text
script -q -e -c "<node> <cli> trust approve master-prompt --path <project>" /dev/null
```

On macOS, run:

```text
script -q /dev/null <node> <cli> trust approve master-prompt --path <project>
```

Write the exact phrase to `script` stdin. Assert the prompt and escaped bytes
appear, the CLI exits zero, the format-2 manifest verifies, exact bytes are
authoritative, and a one-byte mutation is not. Skip explicitly on Windows with
the reason that the harness requires POSIX `script`; do not add a production TTY
bypass.

- [ ] **Step 2: Run the PTY test and verify it fails before any harness repair**

Run:

```sh
node --test --test-name-pattern="genuine PTY" tests/trust-approval-cli.test.js
```

Expected before the final harness/CLI fixes: FAIL on a supported POSIX host.

- [ ] **Step 3: Update security documentation**

Document:

- escaped byte-faithful source view versus normalized agent view;
- invalid UTF-8 refusal;
- exact, bounded confirmation;
- no trust state before confirmation;
- only true missing bindings permit legacy fallback;
- PTY and owner-root deletion residuals remain accepted;
- no Phase 4C feature is present.

- [ ] **Step 4: Run focused SEC-05 verification**

Run the new approval tests plus all Phase 4A/secure-fs suites:

```sh
node --test --test-concurrency=1 \
  tests/trust-approval.test.js \
  tests/trust-approval-cli.test.js \
  tests/trust-store.test.js \
  tests/trust-store-hardening.test.js \
  tests/trust-schema.test.js \
  tests/trust-project-binding.test.js \
  tests/trust-api-boundary.test.js \
  tests/trust-transaction.test.js \
  tests/trust-audit.test.js \
  tests/trust-recovery.test.js \
  tests/trust-crash.test.js \
  tests/secure-fs.test.js
```

Expected: zero failures, zero unexpected skips.

- [ ] **Step 5: Run package and full regression verification**

Run:

```sh
npm run check
npm pack --dry-run
git diff --check
git status --short --branch
```

Expected: all tests and syntax checks pass; the pack includes the approval and
slot-source internals but excludes tests; only intentional tracked changes are
present.

- [ ] **Step 6: Commit Task 4**

```sh
git add SECURITY.md SEC-05-PHASE-4B-PLAN.md \
  noosphere-mcp/tests/trust-approval-cli.test.js noosphere-mcp/package.json
git commit -m "test(SEC-05): gate interactive approval through a real PTY"
```

- [ ] **Step 7: Re-run exact final verification at the resulting HEAD**

Repeat the focused command, `npm run check`, `npm pack --dry-run`, and
`git diff --check`. Record exact totals, skips, OS limitations, HEAD, and changed
files in the hostile-review verdict and `.noosphere/journal.md`.
