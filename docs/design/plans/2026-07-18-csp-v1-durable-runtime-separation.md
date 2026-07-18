# CSP v1 Durable/Runtime Separation Implementation Plan

> **For agentic workers:** Execute inline with strict red-green TDD. Do not
> commit, push, open a PR, or modify the original checkout.

**Goal:** Remove observed Git and process metadata from Git-tracked CSP state
so commits and ordinary lifecycle operations cannot make or dirty their own
continuation truth.

**Architecture:** `.noosphere/state.json` contains exactly the five durable v1
fields. The existing ignored `.noosphere/runtime-state.json` retains watcher
telemetry and gains a namespaced `csp` observation record. Durable writes use
the tracked file's SHA-256 identity plus the existing lock and atomic rename;
Git HEAD is observed for summaries but is not a concurrency field.

**Tech stack:** Node.js ESM, built-in `node:test`, filesystem and Git subprocess
boundaries already used by Noosphere.

## Global constraints

- The tracked schema is exactly `version`, `status`, `current_task`,
  `next_action`, and `blocker`.
- Resume, checkpoint, journal, branch changes, agent changes, and HEAD changes
  never rewrite tracked CSP on their own.
- Existing runtime telemetry migration remains byte-preserving and fail-closed.
- Terminal-state intent rules and deterministic scalar conflicts remain intact.
- No CSP v2 fields or features are introduced.

---

### Task 1: Lock the corrected behavior with regressions

**Files:**
- Modify: `noosphere-mcp/tests/csp-validation.test.js`
- Modify: `noosphere-mcp/tests/csp-storage.test.js`
- Modify: `noosphere-mcp/tests/csp-transitions.test.js`
- Modify: `noosphere-mcp/tests/csp-cli.test.js`
- Modify: `noosphere-mcp/tests/continuity.test.js`

- [x] Replace full-state fixtures with the exact five-field document.
- [x] Add a commit self-reference regression that compares state bytes before
  and after committing `state.json`.
- [x] Add lifecycle regressions proving resume, checkpoint, and journal do not
  rewrite tracked CSP.
- [x] Add observation regressions proving branch and agent changes affect only
  ignored runtime metadata.
- [x] Preserve the explicit-transition and simultaneous-writer conflict tests.
- [x] Run the focused files and confirm failures point to the old expanded
  schema and automatic `touch`/`resume` writes.

### Task 2: Separate durable storage from runtime observations

**Files:**
- Modify: `noosphere-mcp/continuity/csp/schema.json`
- Modify: `noosphere-mcp/continuity/csp/validate.js`
- Modify: `noosphere-mcp/continuity/csp/storage.js`
- Modify: `noosphere-mcp/continuity/csp/merge.js`
- Modify: `noosphere-mcp/continuity/csp/transitions.js`

- [x] Restrict validation to the exact durable schema and keep existing string
  safety and blocked-state invariants.
- [x] Keep tracked-file SHA-256 identity as the optimistic concurrency token.
- [x] Remove Git observation, measured-field injection, and automatic transition
  types from durable writes.
- [x] Store optional local `csp` observation metadata by merging it into the
  existing runtime object without discarding watcher fields.
- [x] Keep deterministic three-way merge behavior for durable fields.
- [x] Run focused storage, merge, validation, and transition tests to green.

### Task 3: Remove automatic durable mutations and combine summaries

**Files:**
- Modify: `noosphere-mcp/continuity/csp/summary.js`
- Modify: `noosphere-mcp/continuity/index.js`
- Modify: `noosphere-mcp/tests/csp-cli.test.js`
- Modify: `noosphere-mcp/tests/continuity.test.js`

- [x] Remove tracked CSP writes from initialization, resume, checkpoint, and
  journal flows.
- [x] Render durable task truth with current Git observations, optional runtime
  metadata, and bounded quoted journal context.
- [x] Make canonical JSON output contain only the five durable fields and make
  transition success output independent of a tracked revision.
- [x] Run CLI and continuity tests to green.

### Task 4: Correct the protocol and verify the repository

**Files:**
- Modify: `.noosphere/state.json`
- Modify: `CSP.md`
- Modify: `README.md`
- Modify: `noosphere-mcp/README.md`
- Modify: `CHANGELOG.md`
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`
- Modify: `GEMINI.md`

- [x] Rewrite the local canonical state to the five-field v1 form.
- [x] Document durable/runtime ownership, identity-based concurrency, summary
  composition, and fail-closed telemetry migration.
- [x] Update generated adapter wording so Git is compared with runtime
  observations, never fields inside tracked CSP.
- [x] Run all focused tests, full MCP/ACP tests, relayer tests, package dry-runs,
  reference audits, artifact checks, and `git diff --check`.
