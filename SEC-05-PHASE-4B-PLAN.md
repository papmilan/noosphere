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
| Prompt-injected agent with shell access | can spawn any CLI, non-interactively | `trust approve` refuses without a TTY on **both** stdin and stdout; there is no `--yes`, no env bypass, no config bypass. **Partial mitigation only:** an agent that can allocate a PTY can drive the prompt and compute the phrase offline — see the accepted residual in SECURITY.md |
| Agent driving the CLI over MCP | MCP server surface | MCP exposes no approval tool; the approval service is not exported (`exports` remains `./trust-store` + `./package.json`) |
| Local process without the machine key | can write into `~/.noosphere/trust-v2` | every artifact is MAC-authenticated under the machine key; forged/edited artifacts fail closed |
| Rollback attacker | can restore an older approved state | per-slot format-2 manifest is authoritative once present; a stale **format-1** record for the same slot is ignored, so downgrade-by-fallback is not available |

**Documented residual risks (accept, do not paper over):**

1. **The TTY gate does not establish human presence.** It blocks ordinary piped,
   redirected, and scripted approval. It does not stop an adversary who can run
   commands as the owner: that adversary allocates a PTY (`script`, `expect`,
   `openpty`) and drives the prompt. Reading the terminal output is **not**
   required — the phrase is `approve <slot> <first 8 hex of rawHash>`, computable
   offline by anyone who planted or can read the slot file. No in-process check
   can distinguish a human keystroke from a PTY writer; closing this needs an
   OS-mediated presence proof (keychain, biometric, re-authentication) that a
   child process cannot relay.
2. Someone who can delete format-2 state inside the owner-only trust root and
   retained a superseded format-1 record can fall back to older
   *owner-approved* bytes. It never authorizes attacker-chosen bytes.

Phase 4B deliberately adds no Phase 4C migration, revocation, restore,
tombstone, identity-switching, or legacy-retirement feature.

## 3. Design

### 3.1 `continuity/slot-sources.js` (new, not exported)

Single resolver:
`resolveSlotSource(root, slot) -> { bytes: Buffer, text: string }`.

| Slot | Bytes |
|------|-------|
| `master-prompt` | `.noosphere/master-prompt.md` contents, exactly as `readMasterPrompt` returns them |
| `instructions` | `.noosphere/instructions.md` contents, exactly as `ollamaFromCli` reads them |
| `baseline` | `.noosphere/baseline.md` with the `# Noosphere project baseline` header stripped and trimmed — the exact expression already at `index.js` refreshContext |

The resolver reads a `Buffer`, decodes with a fatal UTF-8 decoder, and encodes
the single derived text once. Invalid UTF-8 therefore refuses approval and sink
consumption instead of collapsing distinct byte strings through U+FFFD.
Master-prompt and instructions retain exact file bytes; baseline retains the
established derived-body policy. Both sinks and the approval command call this
one function. `resolveSlotBytes` remains only as a text compatibility helper.

### 3.2 `continuity/internal/approval-service.js` (new, internal)

```js
approveSlot({ projectRoot, slot, env, confirm, output, secureFileOptions })
```

* validates the slot, then **requires the terminal before touching the store**:
  a non-interactive caller is refused (`approval-requires-tty`) before a binding
  is created or recovery runs, so an agent that cannot approve cannot leave any
  trust state behind either;
* resolves and retains bytes before any store access; invalid UTF-8 and empty
  content fail before confirmation and before trust-store mutation;
* shows a complete `\xHH`-escaped byte-faithful source view and, separately,
  `renderSlotBlock(text, { authoritative: true })`, the normalized view sinks
  emit. The escaped source path cannot inject terminal controls either;
* calls `confirm({ slot, rawHash, contentHash, byteLength, escapedBytes,
  rendered })`, which must resolve `true`; anything else aborts without writing;
* only after confirmation opens the format-2 store, creates/reads the binding,
  runs fail-closed recovery, and commits the retained bytes. A first approval
  initializes the owner-only root and machine key at this point, never earlier.

`confirm` and `output` are constructor parameters with TTY defaults. Tests inject
a fake `confirm`; **production has no flag that reaches a non-TTY confirm** — the
default is the only one the CLI can construct.

### 3.3 CLI — `noosphere trust approve <slot>`

* `trust` command, `approve` subcommand, `--path` honoured as elsewhere.
* Requires `process.stdin.isTTY && process.stdout.isTTY`; otherwise exits
  non-zero with `approval requires an interactive terminal`.
* Prints project realpath, slot, byte length, `rawHash`, `contentHash`, then the
  escaped byte view and normalized rendered block, then requires the owner to
  type exactly:
  `approve <slot> <first 8 hex of rawHash>`.
  A typed phrase, not `y/N`: it cannot be satisfied by a stray newline, a held
  Enter key, or a `yes |` pipe (which is non-TTY anyway).
* The confirmation is compared without trimming, case folding, normalization,
  prefixes, or suffixes and is bounded to 256 input bytes. EOF, interruption,
  overlong input, or any mismatch refuses without creating trust state.
* On success prints generation, recordId, and the audit event id.

### 3.4 Read path — `isSlotAuthoritative`

The binding path is tri-state:

```text
binding lstat == ENOENT
  -> format-2 is truly absent; format-1 may govern
binding is present and securely verifies
  -> manifest present: format-2 is the sole decision
  -> this slot's manifest absent: format-1 may govern this never-approved slot
binding is a symlink/directory/unreadable/malformed object, or lookup/read fails
  -> false; never downgrade
```

Thus only genuinely missing format-2 state permits compatibility fallback.
Every unsafe or ambiguous state fails closed. Once a valid slot manifest
exists, format-1 cannot authorize different bytes.

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

1. No authority without a keystroke at a TTY. (A TTY is not proof of an owner: see the SECURITY.md residual.)
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

`tests/trust-approval-cli.test.js` (new) — real child processes:
* `noosphere trust approve master-prompt` with piped stdin exits non-zero, prints
  the TTY refusal, and mints nothing;
* the same with `yes |` in front, likewise;
* `--help`-style misuse exits non-zero without touching the store.
* a genuine POSIX PTY accepts the exact phrase, shows the safe byte and
  normalized prompt views, commits a verifying format-2 manifest, authorizes
  only exact bytes, and rejects a one-byte mutation. Linux uses util-linux
  `script`; macOS uses the system `expect` driver so BSD `script` itself receives
  a controlling PTY. Windows explicitly skips only this POSIX harness.

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

## 5a. Round 4 — the repository-controlled read boundary

Rounds 1–3 hardened the approval boundary and the three authority-capable slot
paths. Round 4 closes the class those rounds only sampled: **every** file read
out of a working tree, and the three-state model that has to survive rendering.

**One primitive.** `readBoundedRegularFile` in `@noosphere/secure-fs` is now the
only read used for repository-controlled paths, in both packages:

| Guarantee | Mechanism | Platform |
|-----------|-----------|----------|
| cannot block | `O_NONBLOCK` — a FIFO/socket/device opens immediately instead of waiting forever in `open(2)` with no error code | POSIX; Windows has no FIFO semantics on these paths |
| cannot be redirected | `O_NOFOLLOW` — a symlinked final component is refused by the kernel | POSIX; on Windows this degrades to a pre-open `lstat` (see the residual below) |
| cannot lie about what it is | `fstat` on the **opened descriptor**, not `lstat` on the path, so the object judged is the object read | all |
| cannot exhaust memory | apparent size checked before a byte is allocated, so a sparse file is refused for the cost of one `fstat` | all |
| cannot outgrow its bound | at most `maxBytes + 1` bytes are read; growth after the `fstat` is detected (`state-file-changed`), never silently truncated | all |

`O_NOFOLLOW` and `O_NONBLOCK` do not exist on Windows, where `fs.constants`
reports them as `0`. The two guarantees that depend on them are POSIX-only; the
three enforced on the opened descriptor hold everywhere.

Call sites converted: `readFollowupPrompts`, `formatLocalJournal`,
`fileHasJournalEntries`, `buildWorkspaceSnapshot`'s journal read, `readJson`
(project config), `printContext`, `storePreparedBaseline`, `ensureLocalExcludes`,
`upsertManagedBlock`, `removeManagedBlock`, `removeLegacyProjectFiles`,
`readHandoffSource`, `execImportPlan`, the Ollama session's context and journal
reads, and the lock/exclude reads in `continuity/csp/storage.js`,
`continuity/acp/store.js` and `continuity/acp/sync-metadata.js`. No bare
`readFile` on a repository path remains in `continuity/index.js`.

**Bounds.** Authority-capable slots: 1 MiB (`MAX_SLOT_SOURCE_BYTES`). Other
repository inputs: 8 MiB (`MAX_REPOSITORY_INPUT_BYTES`), because `journal.md` and
`followups.jsonl` grow legitimately. Locks: 4 KiB. Neither slot nor repository
bound is configurable — a tunable security bound is a downgrade switch.

**Degradation policy, explicit.** A classified failure (`slot-invalid-utf8`,
`slot-not-regular-file`, `slot-too-large`, `slot-changed-during-read`, `EISDIR`,
`ENOTDIR`, `ELOOP`, `EACCES`, `EPERM`) degrades read-only render paths to *present
but unusable*. Everything else — `EIO`, `ENOMEM`, any unrecognised code —
propagates, so a genuine fault never hides behind a silently empty render.
Write, capture, and approval paths keep the strict refusal.

**Three states, not two.** `resolveSlotSource` now reports `present`, so ABSENT,
PRESENT-AND-USABLE, and PRESENT-BUT-UNUSABLE stay distinct end to end:

* present-but-unusable is non-authoritative (empty bytes; `isSlotAuthoritative`
  rejects empty outright);
* it does **not** select Walrus restoration — otherwise a tree writer could swap
  the rendered baseline or master prompt for relayer content by corrupting the
  local file;
* the shared context renders a fail-closed notice naming the failure class and
  never a byte of the file, instead of "No master prompt has been recorded";
* `noosphere protocol` applies the same model in the other direction: absent,
  malformed, non-regular, and unreadable instructions share one strict contract
  — nonzero exit plus a diagnostic. (Absence had regressed to zero bytes and exit
  0 when Phase 4B routed it through the slot resolver; present-but-empty keeps
  the pre-4B zero-bytes/exit-0 behaviour, because an empty file is a readable
  file.)

**Symlink policy — Option B, deliberately.** A slot file that *is* a symlink is
rejected; a slot file reached *through* a symlinked parent directory is
supported. Rationale, compatibility note, and the migration instruction are in
SECURITY.md.

**Residual.** On Windows `O_NOFOLLOW`/`O_NONBLOCK` do not exist, so the no-follow
guarantee degrades to a pre-open `lstat` with a small TOCTOU window. Maximum
impact: reading content the tree writer redirected to. It cannot make that
content authoritative (approval binds exact bytes through a separate interactive
transition) and it cannot exceed the size bound, which is enforced on the opened
descriptor. POSIX has no such window.

`tests/slot-source-safety.test.js` and
`noosphere-secure-fs/tests/bounded-read.test.js` (both new) pin all of the above.

## 6. Verification gates before PR

1. Focused SEC-05 + secure-fs suites green on macOS locally, then Linux + macOS +
   Windows in CI (Windows gates the merge — `trust-crash` and the ACL paths run
   there).
2. `node --check` clean for every new module (add them to `package.json#check`).
3. `npm pack --dry-run` shows the new internal modules shipped, tests excluded.
4. No change to `exports`.
5. Hostile exact-head review before the PR is marked ready.
