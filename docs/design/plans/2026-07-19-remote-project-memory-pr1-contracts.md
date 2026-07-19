# Remote Project Memory PR 1 Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define and test the versioned, provider-neutral contracts for remote, model-independent project memory without starting a remote service or changing current Noosphere behavior.

**Architecture:** A new private `noosphere-remote-mcp` package contains only pure schema validators, static MCP contracts, and a storage-port definition. Existing CSP, ACP, CLI, and relayer packages remain outside the dependency graph. Documentation records the separate-service, PostgreSQL, OIDC, and Walrus decisions plus the later implementation sequence.

**Tech Stack:** Node.js 22 ESM, `node:test`, JSON Schema draft 2020-12, Markdown ADRs.

## Global Constraints

- `noosphere-remote-mcp` has no HTTP listener, database driver, OIDC SDK, Dockerfile, or runtime dependency in PR 1.
- CSP, ACP, `noosphere-mcp`, and `noosphere-relayer` behavior and package metadata remain unchanged.
- Project ownership comes only from authenticated request context; no public MCP input contains an owner, tenant, user, subject, token, or authorization field.
- Store only bounded, user-visible structured checkpoints; reject hidden reasoning, full transcripts, attachments, URLs, and arbitrary extension data.
- Persisted checkpoint text is untrusted data when returned to a model.
- Project selection is deterministic and returns ambiguity instead of choosing a low-confidence candidate.

---

### Task 1: Record the architectural decisions

**Files:**
- Create: `docs/design/specs/2026-07-19-remote-project-memory-contracts-design.md`
- Create: `docs/adr/0003-remote-project-memory-service-boundary.md`
- Create: `docs/adr/0004-project-memory-postgresql-control-plane.md`
- Create: `docs/adr/0005-project-memory-provider-neutral-oidc.md`
- Create: `docs/adr/0006-project-memory-walrus-boundary.md`
- Create: `docs/project-memory/ARCHITECTURE.md`
- Create: `docs/project-memory/THREAT_MODEL.md`

- [ ] **Step 1: Write the architecture and ADRs**

Document the separate remote service, a PostgreSQL control plane, OAuth 2.1/OIDC resource-server boundary, and Walrus exclusion. Specify the durable-state limitation, EU reference deployment boundary, deletion/archive semantics, and threats before implementation.

- [ ] **Step 2: Review scope**

Run: `rg -n "TBD|TODO|hidden chain|transcript|Walrus" docs/design/specs/2026-07-19-remote-project-memory-contracts-design.md docs/adr/000[3-6]* docs/project-memory`

Expected: no unbounded or contradictory implementation commitment; each deferred capability is assigned to a later PR.

- [ ] **Step 3: Commit**

```bash
git add docs/design/specs/2026-07-19-remote-project-memory-contracts-design.md docs/adr/000[3-6]* docs/project-memory
git commit -m "docs: define remote project-memory architecture"
```

### Task 2: Add versioned schemas and pure validation

**Files:**
- Create: `noosphere-remote-mcp/package.json`
- Create: `noosphere-remote-mcp/index.js`
- Create: `noosphere-remote-mcp/contracts/constants.js`
- Create: `noosphere-remote-mcp/contracts/schemas.js`
- Create: `noosphere-remote-mcp/contracts/validation.js`
- Create: `noosphere-remote-mcp/schemas/project-1.0.0.json`
- Create: `noosphere-remote-mcp/schemas/session-1.0.0.json`
- Create: `noosphere-remote-mcp/schemas/checkpoint-1.0.0.json`
- Test: `noosphere-remote-mcp/tests/validation.test.js`

- [ ] **Step 1: Write the failing validation test**

```js
assert.throws(() => validateCheckpoint({ ...checkpoint, hidden_chain_of_thought: 'private' }), /unknown-field/);
assert.throws(() => validateCheckpoint({ ...checkpoint, decisions: Array(101).fill('x') }), /array-limit/);
assert.throws(() => validateCheckpoint({ ...checkpoint, revision: 2, previous_checkpoint_id: checkpoint.id }), /revision-predecessor/);
```

- [ ] **Step 2: Run the new test to verify it fails**

Run: `npm --prefix noosphere-remote-mcp test`

Expected: FAIL because the contract package does not exist.

- [ ] **Step 3: Implement the smallest pure contract boundary**

Export `PROJECT_MEMORY_SCHEMA_VERSION`, immutable limits, JSON Schema documents, and `validateProject`, `validateSession`, and `validateCheckpoint`. Validators must reject unknown fields, control characters, disallowed private-reasoning keys, invalid IDs/timestamps/enums, oversize strings/arrays/payloads, and invalid checkpoint revision/predecessor relationships.

- [ ] **Step 4: Run the new test to verify it passes**

Run: `npm --prefix noosphere-remote-mcp test`

Expected: PASS with schema, limit, and forbidden-content assertions.

- [ ] **Step 5: Commit**

```bash
git add noosphere-remote-mcp
git commit -m "feat: add project-memory contracts"
```

### Task 3: Define storage, tools, errors, and continuation semantics

**Files:**
- Create: `noosphere-remote-mcp/contracts/repository.js`
- Create: `noosphere-remote-mcp/contracts/mcp-tools.js`
- Create: `noosphere-remote-mcp/contracts/errors.js`
- Create: `noosphere-remote-mcp/contracts/freshness.js`
- Create: `noosphere-remote-mcp/tests/contracts.test.js`
- Create: `docs/project-memory/MCP_TOOL_CONTRACT.md`
- Create: `docs/project-memory/STORAGE_AND_LIFECYCLE.md`

- [ ] **Step 1: Write failing contract tests**

```js
assert.ok(MCP_TOOLS.resume_project);
assert.equal(/owner|tenant|subject|authorization|token/i.test(JSON.stringify(MCP_TOOLS)), false);
assert.deepEqual(assessResumeFreshness({ latestSessionActivityAt, latestCheckpointAt, sessionStatus: 'interrupted' }).warnings.map(({ code }) => code), ['interrupted-session', 'checkpoint-predates-session']);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test noosphere-remote-mcp/tests/contracts.test.js`

Expected: FAIL because tool and freshness contracts do not exist.

- [ ] **Step 3: Implement static contracts only**

Expose the 15 approved tools, structured error envelopes, cursor pagination, idempotency requirements, continuation warnings, and a storage port that requires an authenticated `ownerScope` supplied by server context. Include an in-memory test repository that enforces owner-scoped IDs; define—but do not implement—the PostgreSQL port.

- [ ] **Step 4: Run tests**

Run: `npm --prefix noosphere-remote-mcp test`

Expected: PASS; tests prove owner fields cannot enter public tool inputs, ambiguity remains explicit, and incomplete state is reported honestly.

- [ ] **Step 5: Commit**

```bash
git add noosphere-remote-mcp docs/project-memory
git commit -m "docs: specify remote MCP project-memory contracts"
```

### Task 4: Document later delivery and verify PR scope

**Files:**
- Create: `docs/design/plans/2026-07-19-remote-project-memory-implementation.md`
- Modify: `README.md` only if needed to state the planned capability as not yet available; otherwise no README change.

- [ ] **Step 1: Write the later-PR execution plan**

Specify PR 2 core transitions, PR 3 Postgres/OIDC, PR 4 Streamable HTTP service, PR 5 client acceptance, and PR 6 deployment documentation. Each later task must preserve CSP/ACP and require real-client validation before compatibility claims.

- [ ] **Step 2: Run focused and existing verification**

Run:

```bash
PATH=/Users/milanpap/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin:$PATH npm --prefix noosphere-remote-mcp test
PATH=/Users/milanpap/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin:$PATH npm --prefix noosphere-acp-protocol test
PATH=/Users/milanpap/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin:$PATH npm --prefix noosphere-mcp run check
PATH=/Users/milanpap/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin:$PATH npm --prefix noosphere-relayer run check
npm --prefix noosphere-mcp pack --dry-run
npm --prefix noosphere-relayer pack --dry-run
git diff --check
```

Expected: all contract and existing checks pass; package dry-runs list no `noosphere-remote-mcp` files.

- [ ] **Step 3: Commit**

```bash
git add docs/design/plans/2026-07-19-remote-project-memory-implementation.md README.md
git commit -m "docs: plan remote project-memory delivery"
```
