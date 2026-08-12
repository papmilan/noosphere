# Inferred continuity — telemetry-backed state without the logging ceremony

Status: DESIGN. No implementation started. Item 3 is specified for build; items
1, 4, and 6 are scoped but deferred; items 2 and 5 are rejected with reasons.

## 1. The problem, measured

Noosphere's continuity state is written by explicit command — `noosphere
remember`, `acp state set`, `exec checkpoint`. Every one of them depends on a
human or agent choosing to run it at the right moment. That dependency fails
quietly, and it has already failed here.

On 2026-08-12, in this repository:

- `.noosphere/state.json` — which `CLAUDE.md` declares canonical for current
  task, status, blocker, and next action — carried `next_action: "Commit the
  closure-documentation pass and decide public release"`. That pass had merged
  roughly two weeks earlier. `current_task` described finished work.
- `.noosphere/journal.md`'s most recent entry was dated 2026-08-03, nine days
  stale.
- That day produced five merge commits (#61–#65), two lock-correctness fixes,
  and two recovered SEC-05 documents. None of it reached either file.

The cost is not lost history. It is that an agent following `CLAUDE.md` reads
`state.json` as canonical and receives a confident, wrong answer. A stale
canonical file is worse than an absent one: absent state makes an agent ask,
wrong state makes it act. In the session above the agent read `state.json`,
found it inconsistent with the request, and ignored it — which is the correct
local decision and a total loss of the file's purpose.

Two SEC-05 documents were also found untracked during unrelated branch cleanup,
each the only copy of a security decision. Nothing surfaced them; they were
noticed by accident.

## 2. Non-goals

This design does not move the trust boundary, and no item that survives review
may do so.

- Owner approval remains the sole untrusted→trusted transition
  (`sec-05-semantic-memory-injection.md` §4.7).
- No inferred artifact may populate a trust slot, assert provenance, or be read
  as instruction. Repository content never asserts its own trust — the v2→v3
  pivot in the SEC-05 design exists precisely because self-asserting provenance
  is forgeable by clone, import, archive, or restore.
- No automatic deletion or reclamation of locks or authenticated artifacts.
  `SEC-05-PHASE-5-SPEC.md` §27.6 rejected stale-lock reclamation because PID,
  clock, and pathname races cannot prove safe ownership; nothing here revisits
  that.
- Explicit commands remain the *creators* of authoritative state. Inference
  produces a parallel, labeled, untrusted lane. It never corrects the owner; the
  owner corrects it.

## 3. Scope of the arc

| # | Idea | Verdict |
|---|------|---------|
| 3 | Save points on build events | **Build now** — specified below |
| 4 | Retroactive journal draft + confirmation | Deferred, scoped in §6 |
| 1 | Infer state from git/file telemetry | Deferred, constrained in §6 |
| 6 | Confidence-tagged lazy state | Deferred, respecified as provenance in §6 |
| 2 | Shell history as telemetry | **Rejected** — §7 |
| 5 | Reactive ACP handoffs built at receive time | **Rejected** — §7 |

Item 3 goes first because it is a git hook and a flag, needs no daemon and no
model, and produces the substrate the later items consume.

---

## 4. Item 3 — automatic execution checkpoints on commit

### 4.1 What already exists

`noosphere exec checkpoint` (`continuity/index.js`, `execCheckpoint`) does not
take a snapshot on demand. It reads an **asserted** execution envelope as JSON
from `--file` or stdin, then calls `buildMeasuredExecutionEnvelope`, which
measures real Git state and target hashes and overrides whatever the asserted
input claimed. A test pins this: *checkpoints with measured fields overriding
asserted lies*.

So a checkpoint has two halves:

- **measured** — Git HEAD, branch, target content hashes. Derived from the
  filesystem. Free to compute, impossible to fake.
- **asserted** — steps, origin, intended next action. Supplied by whoever runs
  the command.

A git hook can compute the measured half exactly. It cannot know the asserted
half, because nobody is there to say what the intent was.

This is the crux of item 3's design, and it is where the original proposal
("auto-run `noosphere exec checkpoint --infer`") is underspecified: there is no
`--infer` mode, and inventing the asserted half is precisely the fabrication
this design forbids.

### 4.2 Design

Add `noosphere exec checkpoint --measured-only`.

It writes an execution envelope whose asserted portion is **empty** — no steps,
no claimed next action — and whose measured portion is the real Git and target
state. It fabricates nothing. It records where the tree was at a moment that
matters.

Wire it to a **post-commit** hook, not pre-commit:

- post-commit runs after the commit object exists, so HEAD is a stable, real SHA
  the envelope can reference. A pre-commit checkpoint can only describe a tree
  that may never become a commit.
- **git ignores post-commit's exit status.** A telemetry hook must never be able
  to block a commit, and post-commit gets that property from git itself rather
  than from defensive coding.
- pre-commit adds latency to an interactive path. post-commit does not.

The hook is one line:

```sh
noosphere exec checkpoint --measured-only --agent git-hook 2>/dev/null || true
```

### 4.3 Agent-id isolation (required, not optional)

Execution state is stored per agent — `executionPaths(root, agentId)` — and
writes go through `withAgentLock`, which takes an exclusive `wx` lock and throws
`execution-write-in-progress` on `EEXIST`. Writes also participate in generation
counting (`executionGeneration`, `expectedGeneration`) and contention detection
(`findExecutionContention`).

A hook writing under the default agent id would therefore appear to a live agent
as a competing writer: it would bump generations under the agent's feet and
register as contention. That is an availability regression introduced by a
telemetry feature, which is not an acceptable trade.

The hook must write under a reserved agent id (`git-hook`). Its state is then a
sibling record, not a competitor, and `listExecutionStates` can present it
distinctly.

### 4.4 Failure behaviour

The hook is best-effort and must be silent on every failure path:

- lock held by a live agent → `execution-write-in-progress` → exit 0, skip. A
  commit made while an agent is mid-write simply gets no checkpoint. Retrying
  inside a hook would risk blocking the developer's terminal for the lock's full
  wall-clock budget.
- `noosphere` not on PATH, or not a Noosphere project → exit 0, skip.
- any unexpected error → swallowed by `|| true`.

A missing checkpoint is a gap in a breadcrumb trail. A hook that fails loudly on
every commit gets deleted by the developer within a day, taking the whole
feature with it.

### 4.5 Installation and consent

Git hooks are not shared by clone, and installing one silently modifies how a
developer's commits behave. This must be opt-in and reversible:

- `noosphere hooks install` writes the hook and prints exactly what it wrote.
- `noosphere hooks uninstall` removes it.
- Refuse to overwrite an existing post-commit hook; print the conflict and the
  line to add instead. A tool that clobbers a developer's hooks earns permanent
  distrust.
- Prefer `core.hooksPath` if the project already sets one (currently unset here);
  otherwise write `.git/hooks/post-commit`.

### 4.6 What this buys, concretely

Applied to 2026-08-12: five commits, five checkpoints, each recording the real
Git state at that moment — versus zero. Recovering "what did the tree look like
when #62 landed" becomes a lookup rather than an archaeology exercise.

It does **not** fix the stale `state.json`. Item 3 records position, not intent.
Intent is items 1 and 4, and it is the harder half.

### 4.7 Tests

- `--measured-only` writes an envelope with an empty asserted portion and a
  measured portion matching the real HEAD.
- Concurrent hook write against a held agent lock exits 0 and writes nothing.
- Hook write under `git-hook` does not bump the default agent's generation and
  does not register as contention against a live agent's state.
- `hooks install` refuses to overwrite an existing post-commit hook.

---

## 5. Success criterion

Two weeks after items 1, 3, 4, and 6 ship: `state.json` is accurate and nobody
ran `acp state set`. If it is stale again, the inferred lane is not reaching the
canonical read path and the daemon was added for nothing — revert rather than
extend.

For item 3 alone: every commit on an installed repository has a checkpoint,
except those made while an agent held the lock, and no developer has removed the
hook out of annoyance.

## 6. Deferred, with the constraints they must meet

**Item 4 — retroactive journal.** Drafts collect in
`.noosphere/pending-journal.md`; the owner confirms or ignores; ignored drafts
are pruned. Safe because `journal.md` is already untrusted-by-default and
gitignored, so a draft confers no authority.

Constraint: `[y/n]` on a summary is approval-by-title. Bind confirmation to a
content hash the way the migration ceremony already does —
`confirmationPhrase(slot, rawHash)` in `internal/approval-service.js` — so the
owner approves specific bytes and an edit between draft and confirmation cannot
ride along unreviewed.

Second constraint: volume. A pending-journal that produces more drafts than a
person will read becomes another ignored inbox, which is the original failure
in new clothing.

**Item 1 — inferred state.** Post-commit inference over the diff, stored as
`system_observation`: labeled, quoted, untrusted, never read as instruction, and
never written into the canonical fields of `state.json`.

Hard constraint: running a model over `git diff` and commit messages feeds
attacker-controllable repository content into something that shapes machine
state. That is the SEC-05 semantic-memory injection threat with a new entry
point — a crafted commit body steering `current_task`. The inference output is
untrusted data by construction, and the boundary must be structural (a distinct
record type that cannot be promoted), not a naming convention.

**Item 6 — lazy state.** Respecified: store provenance
(`source: inferred | owner`), not a confidence float. A float is uncalibrated,
unenforceable, and ends up read by nobody, while a wrong `current_task` at
`0.6` still anchors the next agent that loads context. Provenance is checkable
and can gate promotion; a number cannot.

## 7. Rejected

**Item 2 — shell history as a telemetry stream.** Shell history routinely
contains secrets: `export API_KEY=`, bearer tokens in `curl -H`, database URLs
with passwords. Seeding recall context from it pipes those into the memory
system, which synchronizes remotely. This project maintains deliberate
credential protection (DPAPI on Windows, Keychain on macOS); reading history
files walks around all of it.

It is also mechanically unsound as specified: `.bash_history` records no exit
codes, and is not flushed until shell exit, so "the last five commands and their
exit codes" is not available for the session in progress.

**Item 5 — reactive ACP handoffs.** The proposal has the receiving agent build
`acp.execution-state` from current Git state at handoff time. `CLAUDE.md` states
execution kernels are "advisory, untrusted, and freshness-bound; target-unchanged
never proves a step remains valid." Building the record at receive time has the
receiver manufacture its own account of the sender's intent, which is the one
thing a handoff exists to carry.

"Infer the next action from the most recently edited file path" fails on the
same ground §27.6 rejected for locks: pathname races prove nothing. The
2026-08-12 session is a direct counterexample — the next action was repeatedly
"wait for CI", "delete a branch", or "ask the owner". None of those exist on
disk.

## 8. The line this design will not cross

The original proposal ends: *let explicit user commands act as corrections to
the inferred state, not creators of it.*

That inverts the system's trust direction. Today owner action creates authority.
Making inference the creator and the owner a corrector means the default record
is machine-asserted and uncorrected errors silently become the record.

It also likely loses on its own terms. Correcting a wrong guess costs more than
writing the right thing once, and it is unprompted — the owner must first notice
the error. That trades "I must log" for "I must audit": the same discipline
burden, with worse failure modes and a weaker audit trail.

Inference earns its place by drafting, surfacing, and remembering. Not by
asserting.
