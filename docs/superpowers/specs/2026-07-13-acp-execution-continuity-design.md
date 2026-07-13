# ACP Execution Continuity — Design

**Status:** Proposed (hostile review passed with constraints)
**Protocol:** `acp.execution-state/1`, extending ACP `1.0.0` without schema changes to the Project State Envelope
**Depends on:** ACP continuity kernel (merged `1265dd5`), ACP remote exact-state sync (merged `7f7043c`)

---

## 1. Hostile Review

The feature was assumed wrong and attacked before design.

### Does Project State already solve this?

Partially. Project State carries `goal`, `phase`, `plan[]`, `next_actions[]` (with
priority), `blockers[]`, and `decisions[]`, and the kernel already renders one
`NEXT:` line. What it structurally cannot carry:

- position *inside* a task — which file, which symbol, which step of a
  red/green cycle the agent was standing in;
- edit ordering and its reasons ("wire.js before store.js: store imports wire");
- validation position ("failing test written, implementation not started");
- the search frontier — what was already inspected and ruled out, which is the
  single largest source of duplicated work on resume.

Evidence this gap is real and the remedy works: this repository's own history.
The eight-task remote-sync plan (checkbox steps, exact commands, expected
outputs) allowed a different model to resume mid-plan within minutes, twice.
That plan file *is* an informal execution state. It is also unvalidated,
unbounded, not Git-bound, and silent about position *within* a task. The
attack therefore partially lands: much of the need is already met by plan
files — so Execution Continuity must **formalize and subsume** the plan-file
pattern (validate it, bind it to the repository, add the cursor), not compete
with it. If it were designed as a parallel notion of "plan," it should be
rejected.

### Is this secretly chain-of-thought?

The dangerous fields are "temporary decisions," "open questions," and
"execution intent" — natural dumping grounds for deliberation. Three rules
keep the boundary honest:

1. Every field must be reproducible from externally observable artifacts:
   the agent's *visible* statements, tool calls and results, the diff, test
   output, repository observation. A grep query and its result are a tool
   call and a tool result — observable. A ruled-out hypothesis stated in a
   visible reply is a stated conclusion, the same class as Project State's
   `rejected_approaches`. Hidden deliberation is neither required nor
   representable.
2. Measured fields (repository hashes, test results, dirty files) are filled
   by the CLI from measurement, never accepted from the model.
3. The same recursive forbidden-content validation ACP v1 applies (private
   reasoning keys, secret patterns) applies here, plus new bounds (below).

Verdict: not chain-of-thought, provided the schema forbids what the rules
above forbid. Without those rules it would degrade into one; they are
therefore normative, not advisory.

### Is this just another summary?

A summary cannot tell you whether it is stale. Execution State is bound to
the repository at three granularities — Project State `snapshot_id`, workspace
fingerprint, and per-step target file content hashes — so a successor can
compute *which parts* to distrust rather than distrusting the whole. That
validation property is the qualitative difference. Remove it and the feature
collapses into prose; it is therefore mandatory.

### Is this prompt engineering? Model-specific? Deterministic?

The rendering layer is prompt engineering in the same trivial sense the ACP
kernel is. The substance — typed objects, freshness classification, bounded
projection — is not. Files, symbols, commands, and test names are universal
to Claude, GPT/Codex, Gemini, Cursor, Aider, and Goose alike; no provider
concept appears in the schema. Validation, staleness classification, and
rendering are pure functions over explicit inputs (ACP discipline).
Extraction is *authored*, not derived — two agents would checkpoint the same
work differently — which is acceptable for the same reason Project State
assertions are authored: authority comes from validation, not authorship.

### Is it secure?

This is the strongest attack. Execution State is a *new prompt-injection
surface with elevated implied trust*: "the previous agent was about to edit
auth.js" reads as instruction. Three structural mitigations are load-bearing:

1. **No payloads.** The schema carries locations and goals, never code
   bodies, diffs, or patches. Validation rejects fenced code blocks and
   oversized values in any prose field. A checkpoint can say *"modify
   `validateEnvelope` in project-state.js to reject duplicate IDs; verify
   with acp-project-state.test.js"* — it can never say *"insert these
   lines."* This kills the worst injection class outright.
2. **Advisory-only rendering.** The projection is framed as a record of what
   the previous agent observed and intended, never as instructions to the
   reader, and every stale item is labeled stale (Section 9).
3. **Validation gates before trust.** Envelope integrity, Project State
   binding, Git compatibility, and per-step hashes must all pass before the
   cursor is even rendered as actionable (Section 8).

### Can another model actually benefit? Can it be implemented safely?

Demonstrated empirically in this repository (codex → claude, claude → codex
resumptions via plan files and journal), and the ACP v1 substrate (wire/domain
boundary, deterministic validation, bounded rendering, atomic storage)
already exists to build on.

### Surviving objections that shaped the design

1. **Half-life.** Execution state decays in hours, not days. It is a stack
   frame, not a ledger. → Mandatory short expiry (default 24 h, hard max
   7 d), aggressive demotion on drift, current-only storage.
2. **Plan-file overlap.** → The step graph *is* the checkbox plan,
   formalized; the CLI imports/exports the existing markdown checkbox syntax.
3. **Extraction friction.** If a checkpoint costs more than replanning, the
   feature fails. → Checkpointing is one CLI call taking structured input
   the agent already produced, with all measured fields gathered by the tool
   in under a second.

## 2. Final Verdict

**Build it — as a second ACP object type on the existing infrastructure, not
a separate subsystem.** Four constraints are non-negotiable and enforced by
schema and validation, not convention: no code payloads; advisory-only
rendering; three-level freshness binding; mandatory short expiry. If any of
the four were dropped, the honest recommendation would be to abandon the
feature.

---

## 3. Architecture

```
                Project State (what is true)          ← ACP 1.0, unchanged
                        ▲ snapshot_id binding
Execution State (where was I standing) ── cursor over one Project State
                        ▲ fingerprint + per-step content hashes
                Repository (reality)                  ← always wins
```

Execution State is a **cursor over a specific Project State snapshot**. It
answers "what was I about to do," never "what is true." It is single-writer
per agent, current-only, short-lived, and always subordinate: repository
reality > user/developer/system instructions > Project State > Execution
State. A conflict at any level voids the levels below it, never the reverse.

New modules, all inside the existing ACP layout:

| Unit | Responsibility |
| --- | --- |
| `noosphere-acp-protocol/execution-schema.json` | `acp.execution-state/1` wire schema |
| `noosphere-mcp/continuity/acp/execution-state.js` | domain object, invariants, no-payload enforcement |
| `noosphere-mcp/continuity/acp/execution-freshness.js` | pure three-level freshness classification |
| `noosphere-mcp/continuity/acp/execution-render.js` | bounded advisory kernel |
| `noosphere-mcp/continuity/acp/execution-store.js` | atomic persistence (store.js pattern) |
| `noosphere-mcp/continuity/index.js` | `noosphere exec …` and `noosphere pause` commands |

Reused unchanged: `wire.js` content addressing (the execution envelope is
canonicalized and content-addressed identically), `git-state.js`
`observeRepository`/`classifyCompatibility`, the `oneLine()` sanitizer, the
atomic temp-and-rename write, the fingerprint exclusion list.

## 4. Execution State Object Model

Top-level envelope (content-addressed, same integrity block as ACP):

| Field | Type | Notes |
| --- | --- | --- |
| `protocol` | `'acp.execution-state/1'` | |
| `project_snapshot_id` | snapshot id | **hard bind** to the Project State this cursor traverses |
| `repository` | observation | head, branch, dirty, workspace_fingerprint at checkpoint time (measured) |
| `origin` | agent_id, client, session_id | |
| `created_at` / `expires_at` | ISO-8601 | `expires_at` **required**; default now+24 h, max now+7 d |
| `cursor` | Cursor | where the agent stood |
| `steps[]` | Step[] | the execution graph, ≤ 64 |
| `frontier` | Frontier | searched / ruled-out, ≤ 10 + 10 |
| `validation` | Validation | last verify command and result (measured) |
| `working_notes[]` | Note[] | ≤ 8 × 240 chars, expiring, forbidden-content-checked |
| `integrity` | as ACP | digest, unsigned/local-unverified signature states |

**Cursor** — `{ step_id, status, opened_files[], target }` where `status ∈
planning | before-edit | mid-edit | verifying | blocked | handoff` and
`target = { file, symbol?, purpose }` (purpose is one sanitized sentence).

**Step** (graph node) — `{ id, parent_step_id, kind, status, target, goal,
verify }`:
- `kind ∈ task | edit | test | verify | investigate | commit`
- `status ∈ done | current | pending | skipped | blocked`
- `target = { file, symbol?, content_hash? }` — `content_hash` is the SHA-256
  of the target file at checkpoint time, measured by the CLI; it is the
  per-step freshness anchor
- `goal` — one sentence, sanitized, **no code**
- `verify = { command, expectation }` — how completion is checked; `command`
  ≤ 200 chars, rendered as a record, never auto-executed

**Frontier** — `searched: [{ query, scope, finding }]`,
`ruled_out: [{ hypothesis, evidence }]`. Both derive from visible tool
calls/results and visible stated conclusions only.

**Validation** — `{ last_command, last_result: pass|fail|error,
failing_tests[] (names only), expected_after_next_step }`. Filled from
measurement by the CLI.

Hard bounds: canonical envelope ≤ 64 KiB (vs 1 MiB for Project State);
every prose field single-sentence-bounded; fenced code blocks and any value
matching diff/patch syntax rejected anywhere in the envelope with error code
`payload-forbidden`.

## 5. Execution Graph

A tree with ordered children — deliberately **not** a general DAG. Software
execution plans are task trees (this repository's own eight-task plan is the
existence proof), and a single-writer cursor needs no merge-capable graph.
Array order is execution order; `parent_step_id` gives nesting
(task → steps); the cursor names exactly one `current` step. The graph is
the formalization of the checkbox plan format already proven to survive
model transitions, so `noosphere exec import-plan <file>` parses the existing
`- [ ]`/`- [x]` markdown into steps, and `exec show --markdown` writes it
back. Every node is expressed in repository vocabulary — file, symbol,
command, test name — which is what makes it model-agnostic.

## 6. Checkpoint Lifecycle

Checkpoints are event-driven and cheap; v1 has no daemon and no timer.

| Trigger | Who | Cost |
| --- | --- | --- |
| Step status transition (done/blocked/current moves) | agent calls `noosphere exec checkpoint` | ~1 s |
| Explicit pause / imminent handoff | `noosphere pause` (checkpoint + journal handoff line) | ~1 s |
| After a Project State write that changes `snapshot_id` | store.js hook rebinds or voids the cursor | ~0 ms |
| Every N operations / context-pressure heuristics | **deferred** — v2, needs agent-harness cooperation | — |

Lifecycle: `checkpoint` (atomic replace of current state) → `resume`
(validate, adopt or void) → `expire` (past `expires_at`: history-only) →
`clear`. Current-only, like Project State v1: the durable ledger remains the
journal and the exact-state sync layer.

## 7. Extraction Pipeline

Authority-ordered sources:

1. **Measured (tool-gathered, never model-supplied):** `git status`
   porcelain, branch/head, workspace fingerprint, target-file content
   hashes, last test command and parsed result. Collected by
   `noosphere exec checkpoint` itself.
2. **Asserted (model-authored, structured):** steps, cursor purpose,
   frontier, notes — supplied as structured JSON via `--file`/`--stdin`,
   exactly like `noosphere handoff`.
3. **Imported:** existing markdown checkbox plans.

The split is the honesty mechanism: an agent physically cannot claim tests
pass — the CLI ran them or parsed their output. Extraction never requires,
reads, or references hidden reasoning; the asserted parts are restatements of
what the agent already said visibly, and their bounds make bulk transcript
dumping impossible.

## 8. Validation Rules (successor side, deterministic)

Executed in order by `noosphere exec show` / adapter load; first failure
demotes:

1. **Envelope:** schema, canonical digest, `payload-forbidden` scan,
   forbidden-key/secret scan, expiry. Fail → state is unreadable or
   history-only; cursor void.
2. **Project State binding:** `project_snapshot_id` equals the current local
   ACP snapshot → full trust. Is an ancestor of it → `rebased` (cursor
   demoted to advisory summary; steps re-checked individually). Unrelated or
   diverged → void.
3. **Git compatibility:** existing `classifyCompatibility`. `exact` /
   `compatible` → cursor actionable. `advanced` → per-step salvage (step 4).
   `diverged` / `foreign` / `unknown` → void.
4. **Per-step hash salvage:** each step whose `target.content_hash` still
   matches the working tree stays `fresh`; mismatches are labeled `stale`;
   steps without hashes inherit the envelope-level verdict.

Output is a pure classification
`{ binding: fresh|rebased|void, steps: {id → fresh|stale} }` consumed by the
renderer. Same inputs, byte-identical output.

## 9. Safety Model

- **Advisory framing is structural.** The kernel's first line is
  `# EXECUTION CHECKPOINT (advisory — validate before acting)`; items render
  as `Previous agent recorded: …`; nothing renders as an imperative.
  Execution State can never override system, developer, or user
  instructions, or repository reality — enforced not by asking nicely but
  because adapters load it *after* master-prompt/follow-ups and the ACP
  kernel, and because voided/stale content renders labeled or not at all.
- **No payloads** (Section 4) — checked at decode, at store, and at render.
- **Sanitized rendering:** every interpolated field passes the existing
  `oneLine()`; `verify.command` renders in backticks as a record with length
  cap, and is never executed by Noosphere.
- **Secrets:** same recursive forbidden-pattern validation as ACP v1.
- **Expiry mandatory**; expired state renders one line: "expired execution
  checkpoint from <date> exists; run `noosphere exec show --history`."
- **Trust levels:** the envelope reuses ACP signature states; unsigned
  remote execution state is never auto-adopted (v1 is local-only anyway).

## 10. Merge Strategy

**There is no merge.** An execution cursor is a stack frame, not shared
state. It is single-writer per `(project, agent_id)`; a checkpoint replaces
that writer's previous state atomically. Concurrent agents produce separate
files (`execution-<agent>.json`), rendered separately; if two fresh cursors
name the same `current` step target, the renderer emits an explicit
`CONTENTION` line (reusing conflict rendering) and demotes both to advisory.
Handoff is read-validate-adopt: the successor either adopts the cursor into
its own new state (new `origin`, new checkpoint) or voids it. Rejecting
merge is the single biggest complexity win in this design and follows
ADR 0002's lesson: divergence is surfaced, never silently collapsed.

## 11. Rendering Strategy

Second bounded kernel, sibling of `render.js`:

- `.noosphere/execution.md`, **≤ 1,200 UTF-8 bytes**, deterministic.
- Section order: advisory header + freshness verdict → current step (file,
  symbol, purpose) → last validation result → next ≤ 3 pending fresh steps →
  blocked steps → frontier one-liners → contention/stale warnings.
- Whole-item inclusion only; mandatory content that cannot fit produces the
  `unsafe-to-summarize` refusal exactly like the ACP kernel.
- Adapter load order becomes: master prompt / follow-ups → ACP kernel →
  **execution kernel** → Git → large context.

## 12. Storage Strategy

- Canonical `.noosphere/execution.json` + projection `.noosphere/execution.md`,
  written temp-then-rename via the store.js pattern, mode 0600, both added
  to the workspace-fingerprint exclusion (no spurious watcher checkpoints)
  and to the generated-file ignore list.
- Content-addressed with the same wire canonicalization; `snapshot_id`-style
  id enables future remote replication.
- **Remote sync: deferred.** When wanted, execution state rides the existing
  exact-state relayer API as a typed object with short TTL — no new
  transport. v1 is local-first, exactly as ACP v1 shipped.
- Migration: purely additive. No `execution.json` → identical behavior to
  today. Older Noosphere versions ignore unknown `.noosphere` files. Schema
  evolution uses the protocol version string, mirroring ACP.

## 13. Failure Recovery

| Failure | Recovery |
| --- | --- |
| Context exhaustion / model switch / human pause | The normal case: last step-transition checkpoint + `noosphere pause` handoff; successor resumes in minutes |
| Crash, power loss | Atomic rename ⇒ old or new checkpoint, never torn; diff between checkpointed fingerprint and current tree shows exactly the unrecorded work |
| Half-written files | Per-step hash mismatch → step `stale`; step's own `verify` records how to re-check |
| Failed tests at handoff | `validation.last_result: fail` + failing test names render first — successor starts at truth, not hope |
| Repository drift / branch switch | `classifyCompatibility` demotes; per-step salvage keeps what survives |
| Concurrent agents | Per-agent states + `CONTENTION` rendering (Section 10) |

## 14. Security Review (summary of new surface)

New attack surface = one new file format read at session start. Mitigations:
content addressing (tamper detection), payload prohibition (no executable
content), sanitized bounded rendering (no line forgery — regression-tested
like the ACP kernel injection fix), advisory framing, validation gates,
mandatory expiry, 0600 permissions, fingerprint exclusion. Residual risk:
a malicious *fresh, binding-valid* checkpoint can still steer attention
("next: weaken validation in security.js"); mitigated by goals-not-payloads
plus the successor's own judgment — equivalent residual to Project State's
`next_actions`, accepted there, accepted here.

## 15. Performance Analysis

Checkpoint: one `git status` + branch/head read + ≤ 64 file hashes (only
step targets; typically < 10) + one canonicalization + two atomic writes —
sub-second on this repository. Resume validation: same order as
`noosphere state validate`. Rendering: pure, microseconds. No daemon, no
polling, no network in v1. Success metrics and measurement: time-to-first-
correct-action after handoff (target < 2 min vs ~30 min replan), first edit
lands in the checkpointed target (binary), first verify command matches the
checkpoint's expectation, zero adoptions of a voided cursor. Measured by the
continuation acceptance fixture (Section 17, Task 6) which replays a
checkpoint into a clean session and asserts the rendered kernel names the
correct file, symbol, and verify command.

## 16. Repository & ACP Integration

CLI additions (all local):

```
noosphere exec checkpoint --file <json> | --stdin   # measured + asserted merge
noosphere exec show [--json|--markdown|--history]
noosphere exec import-plan <markdown-file>
noosphere exec clear
noosphere pause          # checkpoint + journal handoff entry
noosphere state          # gains one line: execution checkpoint freshness
```

Adapters (CLAUDE.md / AGENTS.md generated blocks) add one read step for
`.noosphere/execution.md` after the ACP kernel. `noosphere state validate`
extends to the execution envelope when present. Nothing in Project State,
the relayer, or the sync layer changes in v1.

## 17. TDD Implementation Plan (six tasks, kernel-plan format)

1. **Schema + domain object.** `execution-schema.json`,
   `execution-state.js` (`createExecutionState`), invariant tests: duplicate
   step ids, dangling `parent_step_id`/`cursor.step_id`, missing expiry,
   payload-forbidden (fenced code, diff syntax), bounds, deep-freeze.
2. **Freshness classification.** `execution-freshness.js` pure truth table:
   binding fresh/rebased/void × Git exact/compatible/advanced/diverged ×
   per-step hash salvage. Git fixtures as in `acp-git-state.test.js`.
3. **Bounded advisory renderer.** `execution-render.js`: ≤ 1,200 bytes,
   advisory header always first, stale labeling, contention line, newline-
   injection regression (reuse `oneLine()` tests), overflow refusal.
4. **Atomic store + fingerprint exclusion.** `execution-store.js` +
   exclusion-list change + regression test that a checkpoint write does not
   trigger a watcher checkpoint.
5. **CLI + measured extraction.** `exec checkpoint/show/clear/import-plan`,
   `pause`; test that measured fields come from the fixture repo, not the
   input JSON (attempted lies are overwritten); checkbox import round-trip.
6. **Continuation acceptance + docs.** Fixture: agent A checkpoints mid-task
   → clean process resumes from files alone → rendered kernel names correct
   file/symbol/verify; docs in both READMEs; full check/test/audit gates.

## 18. Exact Repository Changes

Create: `noosphere-acp-protocol/execution-schema.json`,
`noosphere-mcp/continuity/acp/execution-state.js`,
`…/execution-freshness.js`, `…/execution-render.js`, `…/execution-store.js`,
`noosphere-mcp/tests/acp-execution-state.test.js`,
`…/acp-execution-freshness.test.js`, `…/acp-execution-render.test.js`,
`…/acp-execution-store.test.js`, `…/acp-execution-cli.test.js`,
`…/acp-execution-continuation.test.js`,
`…/fixtures/acp/execution-continuation-case.json`.

Modify: `noosphere-mcp/continuity/index.js` (commands, adapter text,
fingerprint exclusion), `noosphere-mcp/package.json` (check script),
`noosphere-acp-protocol/index.js` (schema export), `README.md`,
`noosphere-mcp/README.md`.

Untouched: Project State schema, relayer, sync layer, merge/reconcile code.
