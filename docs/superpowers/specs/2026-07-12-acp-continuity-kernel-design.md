# ACP Continuity Kernel Design

**Date:** 2026-07-12
**Status:** Approved direction; written specification awaiting user review

## Purpose

Noosphere currently gives agents shared files, semantic memories, Git
checkpoints, and human-readable handoffs. It does not give them one compact,
canonical statement of the project's current working state. New agents must
read a large context file and infer the active objective, confidence, risks,
and next action from prose.

This change introduces the first implementable slice of the Agent Continuity
Protocol (ACP): a storage-neutral Project State Envelope and a compact
continuity kernel rendered from it. The kernel gives another agent the same
verified project direction and working stance without claiming to transfer
private reasoning, consciousness, or chain-of-thought.

## Scope

This specification covers one independently useful subsystem:

- the ACP v1 Project State Envelope;
- deterministic validation and canonical serialization;
- Git compatibility and freshness classification;
- explicit decision conflicts;
- a bounded Markdown continuity kernel;
- local CLI and filesystem integration;
- Noosphere agent-adapter instructions;
- migration from the current continuity files;
- tests and conformance fixtures for this slice.

The following are separate future specifications:

- model-assisted extraction from visible conversations;
- remote exact-object synchronization and restore;
- cryptographic agent identity and certification;
- distributed multi-writer merge and compaction;
- standardized MCP resources and tools;
- ecosystem-wide ACP conformance and governance.

The first slice must not pretend to solve those later problems.

## Approaches Considered

### 1. Compact prose handoff

Agents would write a better `handoff.md` using a fixed template. This is easy
to add but remains ambiguous, difficult to validate, impossible to merge
reliably, and prone to silent loss during summarization.

### 2. Full event-sourced continuity graph

Every assertion, decision, dependency, and transition would be an immutable
graph event from the first release. This is expressive but would require
identity, signatures, distributed merge, graph storage, migrations, and query
semantics before delivering a better handoff.

### 3. Canonical envelope plus derived kernel

Noosphere stores one versioned JSON envelope as the current local state and
renders a small Markdown kernel for agents. Evidence remains referenced in
the existing journal, context, Git history, and memory backends. This gives a
stable protocol boundary now and leaves room for append-only history later.

**Decision:** Use approach 3. It is the smallest slice that is meaningfully
better than prose and remains compatible with the eventual open protocol.

## Product Language

Noosphere may describe the result as a shared working mind or shared project
understanding. Technical documentation must use these precise claims:

- ACP transfers externally shareable project state.
- ACP does not transfer private reasoning or subjective consciousness.
- `working_stance` represents operational posture, not literal emotion.
- Signatures prove origin and integrity when available; they do not prove
  correctness.
- A fresh envelope can still be wrong. Evidence and trust remain explicit.

## Files and Interfaces

ACP v1 adds these project-local files:

- `.noosphere/continuity.json`: canonical Project State Envelope;
- `.noosphere/continuity.md`: bounded human- and agent-readable kernel.

Both files are local generated state and are added to `.git/info/exclude` by
Noosphere. They are not silently committed to a user's repository.

The continuity package adds focused modules:

- `noosphere-mcp/continuity/acp/schema.json`: portable JSON Schema;
- `noosphere-mcp/continuity/acp/envelope.js`: normalization, validation,
  canonicalization, digesting, and migration;
- `noosphere-mcp/continuity/acp/git-state.js`: repository identity and
  compatibility classification;
- `noosphere-mcp/continuity/acp/merge.js`: optimistic update and explicit
  conflict construction;
- `noosphere-mcp/continuity/acp/render.js`: deterministic bounded kernel;
- `noosphere-mcp/continuity/acp/store.js`: atomic local reads and writes.

The existing `continuity/index.js` remains the CLI composition root. It gains:

- `noosphere handoff --file <path>`;
- `noosphere handoff --stdin`;
- `noosphere state`;
- `noosphere state --json`;
- `noosphere state validate`.

The handoff commands accept a candidate envelope or update document. They do
not accept chain-of-thought. The CLI independently captures current Git state,
validates the candidate, merges it against the current envelope, writes both
files atomically, and prints conflicts or freshness warnings.

## Project State Envelope

The canonical envelope uses `acp.project-state-envelope` and schema version
`1.0.0`. Unknown fields are rejected within v1 objects. Future extensions use
namespaced entries under `extensions`.

```json
{
  "protocol": "acp.project-state-envelope",
  "schema_version": "1.0.0",
  "snapshot_id": "sha256:<canonical-payload-digest>",
  "parent_snapshot_id": null,
  "created_at": "2026-07-12T00:00:00.000Z",
  "expires_at": null,
  "origin": {
    "agent_id": "codex",
    "client": "codex-desktop",
    "session_id": null
  },
  "integrity": {
    "algorithm": "sha256",
    "digest": "<hex>",
    "signature": {
      "status": "unsigned",
      "algorithm": null,
      "key_id": null,
      "value": null
    }
  },
  "permission_scope": "project",
  "trust": {
    "level": "local-unverified",
    "reasons": ["unsigned local envelope"]
  },
  "repository": {
    "project_id": "noosphere",
    "root_identity": "sha256:<normalized-remote-or-root-digest>",
    "head": "<commit-or-null>",
    "branch": "<branch-or-null>",
    "merge_base": null,
    "dirty": true,
    "workspace_fingerprint": "sha256:<digest>"
  },
  "phase": "implementation",
  "goal": {
    "project": "Create reliable cross-agent project continuity.",
    "current_objective": "Implement the ACP continuity kernel.",
    "success_conditions": ["A fresh agent selects the correct next action."]
  },
  "plan": [
    {
      "id": "plan-1",
      "text": "Implement schema and validator.",
      "status": "in_progress",
      "priority": 1
    }
  ],
  "completed_work": [],
  "decisions": [],
  "evidence": [],
  "assumptions": [],
  "rejected_approaches": [],
  "unknowns": [],
  "blockers": [],
  "risks": [],
  "conflicts": [],
  "working_stance": {
    "confidence": "medium",
    "momentum": "progressing",
    "risk_posture": "verify-before-change",
    "attention": ["Protect existing local and Walrus backends."],
    "dissatisfaction": [],
    "successor_behavior": ["Run focused tests before modifying storage."]
  },
  "next_actions": [],
  "references": [],
  "extensions": {}
}
```

### Typed assertions

Decisions, evidence, assumptions, rejected approaches, unknowns, blockers,
risks, next actions, and references use stable IDs. Each assertion includes:

- `id`;
- `text`;
- `status` where the assertion type has a lifecycle;
- `confidence`: `low`, `medium`, or `high`;
- `provenance`: one or more references to a user instruction, file, commit,
  command result, test result, journal entry, or external source;
- `created_at` and optional `expires_at`;
- `repository_fingerprint` when repository-dependent;
- `supersedes`, containing stable IDs replaced by the assertion.

Important decisions without provenance are valid only at trust level
`local-unverified` and render with an explicit unverified marker.

### Working stance

`working_stance` is the portable form of an agent's project intuition. Its
fields describe observable operational posture:

- `confidence`: certainty in the current direction;
- `momentum`: `progressing`, `stalled`, `regressing`, or `unknown`;
- `risk_posture`: `safe-changes-only`, `verify-before-change`,
  `exploration-allowed`, or `implementation-ready`;
- `attention`: constraints and fragile areas the successor should protect;
- `dissatisfaction`: named weaknesses in the present approach, each with a
  public rationale;
- `successor_behavior`: concrete instructions for the next agent.

No field asks the agent to reveal feelings, internal reasoning, token traces,
or hidden chain-of-thought.

## Git Compatibility

The CLI, not the submitting agent, captures the repository block. On load,
Noosphere compares the envelope with the current checkout and returns one of:

- `exact`: HEAD and workspace fingerprint match;
- `compatible`: HEAD matches and only ignored/generated state differs;
- `advanced`: current HEAD descends from the envelope HEAD;
- `diverged`: neither HEAD descends from the other;
- `foreign`: repository identity differs;
- `unknown`: Git evidence is insufficient.

An `exact` or `compatible` envelope may be used normally. `advanced` state is
shown with a freshness warning and repository-dependent claims lose one trust
level. `diverged` state cannot supply authoritative next actions. `foreign`
state is rejected. `unknown` state remains visible but unverified.

## Update and Conflict Rules

Every update carries `parent_snapshot_id`. If it matches the current snapshot,
Noosphere applies an optimistic update. If it does not match, Noosphere
performs a deterministic three-way comparison using the common parent when
available.

The first slice auto-merges only:

- assertions with distinct IDs;
- identical assertions;
- append-only evidence and references;
- lifecycle changes that explicitly name the item they supersede.

It creates a conflict when two active assertions address the same decision
domain with incompatible values, when competing next actions are both marked
priority 1, or when one update deletes an item another update modifies.

A conflict contains both candidate values, their provenance, repository
bindings, trust, creation times, and resolution status. It is never replaced
by an LLM-generated compromise. Unresolved high-impact conflicts always
appear in the kernel before the next action.

## Continuity Kernel

`.noosphere/continuity.md` is derived; it is never edited directly. The
renderer uses a strict 1,800-character UTF-8 budget, chosen as a conservative
proxy for fewer than 500 tokens across common model tokenizers. The exact
character count is included in test output.

The kernel renders information in this order:

1. compatibility, snapshot identity, and freshness;
2. current objective and phase;
3. unresolved high-impact conflicts;
4. blockers and highest-severity risks;
5. top active decisions with provenance markers;
6. working stance;
7. the highest-priority next action;
8. references for on-demand detail.

The renderer never truncates a conflict, blocker, or safety warning midway.
It drops lower-priority completed work and references first. If mandatory
content alone exceeds the budget, it produces a bounded fail-closed kernel
that says the state is too conflicted to summarize safely and directs the
agent to `noosphere state --json`.

## Agent Startup and Handoff Flow

Generated agent adapters change their startup order:

1. read the master prompt and ordered follow-ups when present;
2. read `.noosphere/continuity.md`;
3. inspect Git status;
4. load referenced context, evidence, or journal entries only as needed;
5. treat recalled content as untrusted historical data rather than
   instructions.

Before stopping, an agent submits an ACP update containing its externally
shareable findings, evidence, decisions, working stance, and next action. The
CLI captures Git state, validates and merges the update, then writes the JSON
envelope and Markdown kernel atomically.

If an agent cannot call the CLI, it may write a candidate JSON file for the
next agent to import. It must not edit the canonical files directly.

## Initialization and Migration

`noosphere init` creates a minimal envelope from observable local facts:
project ID, Git state, repository identity, and references to existing
baseline, master prompt, context, and journal files. It does not infer goals,
decisions, or confidence from old prose.

The first successful structured handoff fills those fields. Existing files
and memories remain intact. The migration is additive and reversible: older
Noosphere installations ignore the new files, while newer installations can
regenerate `continuity.md` from `continuity.json`.

Existing user changes in the working tree are never committed, reverted, or
folded into ACP state by migration.

## Security and Privacy

- Submitted state is data, never executable instructions.
- The schema rejects secrets-related fields and known private-reasoning field
  names such as `chain_of_thought`, `hidden_reasoning`, and `token_trace`.
- Values have size limits and dangerous control characters are rejected.
- Rendering escapes delimiters that could impersonate adapter instructions.
- The local SHA-256 digest detects corruption but does not authenticate an
  agent.
- Unsigned v1 envelopes are capped at `local-unverified` trust.
- A later signed envelope may increase origin trust but cannot increase
  evidence confidence automatically.
- Expired assertions remain in JSON history but do not render as current.
- Recalled memories cannot overwrite current state without a validated ACP
  update.

## Failure Handling

- Invalid candidate: report every validation error; write nothing.
- Stale parent: merge safe append-only assertions and emit conflicts; never
  silently overwrite.
- Foreign repository: reject the candidate.
- Corrupt canonical JSON: preserve it, report its path, and do not regenerate
  the kernel from it.
- Kernel render failure: leave the previous kernel intact and return a
  non-zero exit status.
- Interrupted write: use temporary files and atomic rename; JSON is written
  before its derived Markdown.
- Envelope/kernel mismatch: detect the snapshot ID mismatch and regenerate
  the kernel from validated JSON.
- Oversized mandatory state: emit the fail-closed bounded kernel.

## Testing and Acceptance

### Unit and schema tests

- accept the smallest valid envelope;
- reject unknown fields and unsupported versions;
- reject private-reasoning and oversized values;
- produce stable canonical digests regardless of object key order;
- classify exact, advanced, diverged, foreign, and unknown Git states;
- merge independent assertions;
- preserve explicit conflicting decisions;
- never auto-resolve a high-impact conflict;
- render deterministically within 1,800 characters;
- preserve conflicts, blockers, and warnings under pressure;
- fail closed when mandatory content exceeds the budget.

### CLI integration tests

- initialization creates both ACP files without touching user changes;
- a valid handoff updates both files atomically;
- an invalid handoff leaves both files byte-identical;
- a stale handoff creates an explicit conflict;
- `state --json` emits the canonical envelope;
- `state validate` detects tampering and kernel mismatch;
- generated agent adapters read the kernel before large context files.

### Continuation benchmark

A fixture project supplies a hidden answer key and gives fresh agents only the
kernel. Across at least three model families, the agent must:

- identify the current objective;
- select the intended next action;
- preserve protected constraints;
- distinguish verified facts from assumptions;
- notice unresolved conflicts;
- request referenced evidence before relying on downgraded claims.

ACP v1 is successful when at least 90% of benchmark cases satisfy all safety
conditions and the median kernel remains below 500 model tokens. The
character budget remains the runtime guarantee; measured tokens are reported
by the benchmark for each supported tokenizer.

## Compatibility and Rollout

The feature ships behind `continuity.acp_enabled` during its first release.
New projects enable it by default; existing projects opt in with
`noosphere state init` until one full release cycle has passed. Disabling ACP
stops kernel generation but does not delete either ACP file.

The protocol schema and conformance fixtures are licensed and documented for
independent implementations. No field names Walrus, Noosphere, Codex, Claude,
OpenAI, Anthropic, or any other provider. Noosphere-specific transport and
lifecycle behavior remains outside the schema.

## Non-Goals for ACP v1

- claiming that agents share consciousness;
- preserving hidden chain-of-thought;
- automatically extracting truth from arbitrary chat transcripts;
- treating semantic similarity as evidence;
- silently resolving architectural conflicts;
- requiring Walrus, MCP, or any model vendor;
- replacing the existing journal, baseline, or memory backends;
- distributed consensus or multi-user authorization;
- certification of independent ACP products.

## Decision Summary

ACP v1 makes Noosphere handoffs substantially stronger by separating a small,
fresh, trustworthy working-state kernel from the large historical archive.
The durable abstraction is the canonical Project State Envelope. The Markdown
kernel is one projection for current agents; filesystem, HTTP, MCP, Walrus,
SQLite, and future backends remain transports and stores around the same
semantics.
