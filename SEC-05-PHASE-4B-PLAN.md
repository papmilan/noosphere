# SEC-05 Phase 4B — Interactive owner-approval boundary

Base: `defaaa4` (Phase 4A-R3 merged). Branch: `codex/sec-05-phase-4b`.
Prerequisite: 4A corrective series complete — R1 `8600dc6`, R2 `03c774d`, R3 `defaaa4`.

Phase 4B is the **first user-facing authority transition** in SEC-05. Until now no
supported path could mint format-2 authority; after 4B an owner can approve a
source slot at an interactive terminal and the approved bytes render
authoritative at every sink.

---

## 1. Scope (decided)

In scope:

1. **`noosphere trust approve <slot>`** — interactive owner-approval command
   backed by an in-process trusted approval service that imports
   `continuity/internal/trust-format-v2.js`.
2. **Read-path switch** — `isSlotAuthoritative` consults format-2 first;
   format-1 remains a valid fallback only when no format-2 manifest exists for
   that slot.
3. **One shared slot-byte resolver** so the bytes displayed and approved are the
   exact bytes each sink gates on (the M-2 class of defect, closed by
   construction rather than by convention).

Out of scope (4C / Phase 5, unchanged from the 4A plan §21): revocation,
restore application, format-1 → format-2 migration, Option-B owner-selected
logical project labels, summary provenance, MCP-initiated authority mutation,
replay/freshness.

## 2. Threat model for the new transition

The transition being added is: *owner, at their own terminal, converts untrusted
bytes into authoritative bytes.* Everything else in SEC-05 exists to make sure
nothing **but** that sentence can do it.

| Adversary | Capability | Defence in 4B |
|-----------|-----------|---------------|
| Repository content / clone / archive | can write any file inside the project tree | approval requires an owner keystroke; repo bytes never mint authority, and a changed byte invalidates the record (rawHash + contentHash) |
| Prompt-injected agent with shell access | can spawn any CLI, non-interactively | `trust approve` refuses without a TTY on **both** stdin and stdout; there is no `--yes`, no env bypass, no config bypass |
| Agent driving the CLI over MCP | MCP server surface | MCP exposes no approval tool; the approval service is not exported (`exports` remains `./trust-store` + `./package.json`) |
| Local process without the machine key | can write into `~/.noosphere/trust-v2` | every artifact is MAC-authenticated under the machine key; forged/edited artifacts fail closed |
| Rollback attacker | can restore an older approved state | per-slot format-2 manifest is authoritative once present; a stale **format-1** record for the same slot is ignored, so downgrade-by-fallback is not available |

**Documented residual risk (accept, do not paper over):** an adversary that can
allocate a PTY *and* read the owner's terminal output can satisfy the typed
confirmation. The owner's terminal is the trust boundary; no in-process check can
distinguish a human keystroke from a PTY writer. Reducing this needs an
out-of-band channel (hardware token / OS-level owner prompt) and is out of scope.

## 3. Design

### 3.1 `continuity/slot-sources.js` (new, not exported)

Single resolver: `resolveSlotBytes(root, slot) -> { bytes, origin }`.

| Slot | Bytes |
|------|-------|
| `master-prompt` | `.noosphere/master-prompt.md` contents, exactly as `readMasterPrompt` returns them |
| `instructions` | `.noosphere/instructions.md` contents, exactly as `ollamaFromCli` reads them |
| `baseline` | `.noosphere/baseline.md` with the `# Noosphere project baseline` header stripped and trimmed — the exact expression already at `index.js` refreshContext |

Both sinks and the approval command call this one function. A future sink that
invents its own byte derivation is the defect this module exists to prevent.

### 3.2 `continuity/internal/approval-service.js` (new, internal)

```
approveSlot({ projectRoot, slot, env, confirm, output, secureFileOptions })
```

* validates the slot, then **requires the terminal before touching the store**:
  a non-interactive caller is refused (`approval-requires-tty`) before a binding
  is created or recovery runs, so an agent that cannot approve cannot leave any
  trust state behind either;
* resolves bytes via `resolveSlotBytes`; empty content is refused
  (`approval-empty-slot`) — an empty approval would authorize nothing yet mint a
  generation;
* opens the format-2 store, `createProjectBinding` (idempotent per realpath),
  then `recover(binding, slot)` — a held or malformed lock aborts the approval
  fail-closed, exactly as 4A specifies;
* renders the bytes for display through `renderSlotBlock(bytes, { authoritative: true })`,
  i.e. **the identical rendering the sinks will emit** — the owner approves what
  they will get, and terminal control sequences are already neutralized by the
  pinned normalizer;
* calls `confirm({ slot, rawHash, contentHash, byteLength, rendered })`, which
  must resolve `true`; anything else aborts without writing;
* commits via `commitTransaction({ binding, slot, rawBytes, sourceOrigin })`.

`confirm` and `output` are constructor parameters with TTY defaults. Tests inject
a fake `confirm`; **production has no flag that reaches a non-TTY confirm** — the
default is the only one the CLI can construct.

### 3.3 CLI — `noosphere trust approve <slot>`

* `trust` command, `approve` subcommand, `--path` honoured as elsewhere.
* Requires `process.stdin.isTTY && process.stdout.isTTY`; otherwise exits
  non-zero with `approval requires an interactive terminal`.
* Prints project realpath, slot, byte length, `rawHash`, `contentHash`, then the
  rendered block, then requires the owner to type exactly:
  `approve <slot> <first 8 hex of rawHash>`.
  A typed phrase, not `y/N`: it cannot be satisfied by a stray newline, a held
  Enter key, or a `yes |` pipe (which is non-TTY anyway).
* On success prints generation, recordId, and the audit event id.

### 3.4 Read path — `isSlotAuthoritative`

```
format-2 binding + manifest for (root, slot) exists ?
  yes -> return isFormat2Authoritative(...)      // sole decision, no fallback
  no  -> existing format-1 record check          // unchanged Phase-1 semantics
```

Any error anywhere still fails closed to `false`. The no-fallback-when-format-2-
exists rule is the anti-downgrade property and gets its own negative test.

`createFormatV2Store` currently hard-requires `env.NOOSPHERE_HOME`; 4B makes it
use the same default home as the rest of the trust store
(`~/.noosphere`) so production callers work without an env var. That is a
default, not a new selector: the value still comes from `homeDir(env)` with no
new precedence.

### 3.5 Residual accepted in 4B, closed in 4C

While format-1 remains a fallback for slots with no format-2 manifest, someone
who can delete inside the owner-only trust root **and** kept a superseded
format-1 record can force a slot back to older *owner-approved* bytes. It never
authorizes bytes the owner did not approve, and it needs write access to the
owner-only trust directory. Disclosed in `SECURITY.md`; 4C's migration retires
format-1 and removes it.

## 4. Invariants 4B must not break

1. No authority without an owner keystroke at a TTY.
2. Approved bytes == displayed bytes == the bytes every sink gates on.
3. Format-2 present ⇒ format-1 cannot authorize that slot.
4. Package exports unchanged; no writer reachable from `exports`, deep import,
   MCP, or any adapter.
5. Phase 1–3 behaviour for un-approved and format-1-approved slots is unchanged.
6. Every failure path fails closed.

## 5. Test plan

`tests/trust-approval.test.js` (new)

* approves master-prompt end to end, then `isSlotAuthoritative` is true for the
  exact bytes and false for a one-byte mutation;
* a declined confirmation writes nothing: no manifest, no record, no audit event,
  no journal left behind, and the slot stays non-authoritative;
* empty slot refused;
* unknown / non-format-2 slot refused (`followups`);
* second approval of new bytes mints generation 2, the old bytes stop being
  authoritative, and the audit chain still verifies;
* a held lock (acquired out of band) makes approval fail closed;
* approval binds the byte-exact rendered body for `baseline` (header-stripped),
  proving the resolver and the sink agree.

`tests/trust-approval-cli.test.js` (new) — real child process, no TTY:
* `noosphere trust approve master-prompt` with piped stdin exits non-zero, prints
  the TTY refusal, and mints nothing;
* the same with `yes |` in front, likewise;
* `--help`-style misuse exits non-zero without touching the store.

`tests/trust-store.test.js` (extended)
* format-2 manifest present ⇒ a valid format-1 record for different bytes does
  **not** authorize (anti-downgrade);
* no format-2 manifest ⇒ format-1 behaviour byte-for-byte unchanged.

`tests/adapter-injection.test.js` (extended)
* an approved slot renders unquoted at every enumerated sink, and reverts to
  quoted after a single byte changes.

`tests/trust-api-boundary.test.js` (extended)
* `approval-service.js` and `slot-sources.js` are not exported and not
  deep-importable; both ship in `npm pack`.

## 6. Verification gates before PR

1. Focused SEC-05 + secure-fs suites green on macOS locally, then Linux + macOS +
   Windows in CI (Windows gates the merge — `trust-crash` and the ACL paths run
   there).
2. `node --check` clean for every new module (add them to `package.json#check`).
3. `npm pack --dry-run` shows the new internal modules shipped, tests excluded.
4. No change to `exports`.
5. Hostile exact-head review before the PR is marked ready.
