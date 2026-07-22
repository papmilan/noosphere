# SEC-03 Windows ACL Boundary Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace post-write, friendly-name Windows ACL handling with one SID-based, pre-write, fail-closed persistence boundary shared by every sensitive relayer and MCP file path.

**Architecture:** Add a bundled internal `@noosphere/secure-fs` package containing the single containment, Windows DACL, atomic-write, and repair-before-read implementation. Windows writes use a fixed PowerShell/.NET helper that exclusively creates a same-directory temporary file, installs and verifies an exact three-SID DACL, and only then copies sensitive bytes from standard input through its retained stream. POSIX retains `O_NOFOLLOW`, `0o600`, fsync, and atomic rename semantics.

**Tech Stack:** Node.js 22 ESM, Windows PowerShell/.NET access-control APIs, Node test runner, GitHub Actions.

## Global Constraints

- Do not merge PR #24 or begin SEC-05.
- Allow only the actual token user SID, `S-1-5-18`, and `S-1-5-32-544`.
- Never write sensitive bytes before verified ACL installation.
- Never authorize by friendly name, shell interpolation, or environment fallback.
- Repair existing sensitive files before reading or parsing them.
- Preserve current containment, junction/reparse, and POSIX behavior.

---

### Task 1: Shared security package

**Files:** Create `noosphere-secure-fs/{package.json,index.js,windows-owner-only.ps1,tests/secure-persistence.test.js}`; modify both consumer package manifests and lockfiles.

**Interfaces:** Produce `atomicOwnerOnlyWrite`, `atomicOwnerOnlyWriteSync`, `readOwnerOnlyFile`, `readOwnerOnlyFileSync`, `createOwnerOnlyLock`, and the existing containment helpers.

- [ ] Write injected Windows red tests for SID resolution failure, empty-before-ACL ordering, exact allowlist verification, cleanup at every stage, and repair-before-read.
- [ ] Run the focused tests and observe the missing-API failures.
- [ ] Implement one shared POSIX/Windows boundary and fixed PowerShell helper.
- [ ] Re-run focused tests green.

### Task 2: Relayer migration

**Files:** Modify `noosphere-relayer/{secure-fs.js,credentials.js,durable-store.js,local-memory.js,snapshot-backend.js,tests/windows-acl.test.js}` and relevant containment tests.

- [ ] Add red store tests for arbitrary ACEs, pre-write ordering, forced failures, cleanup, rename preservation, and legacy repair.
- [ ] Route credentials, DurableStore/exact state, LocalMemory, snapshots, and their temporary files through the shared read/write boundary.
- [ ] Run the relayer security suite green.

### Task 3: MCP ACP and execution migration

**Files:** Modify `noosphere-mcp/continuity/{secure-fs.js,acp/store.js,acp/execution-store.js}` and their focused tests.

- [ ] Add red tests for canonical state, transaction new/backup/restore/journal files, execution state/generation, temporaries, and repair failure.
- [ ] Route every sensitive read/write through the shared boundary without changing transaction semantics.
- [ ] Run ACP and execution tests green.

### Task 4: MCP sync/quarantine migration

**Files:** Modify `noosphere-mcp/continuity/acp/{sync-metadata.js,quarantine-writer.js}` and sync tests.

- [ ] Add red tests for legacy repair, pre-write ACL failure, and cleanup.
- [ ] Secure sync metadata, confirmation/upload locks, and quarantine bytes without weakening directory identity checks.
- [ ] Run sync tests green.

### Task 5: CI, inventory, and verification

**Files:** Modify `.github/workflows/ci.yml`, both package scripts, and create `docs/security/sec-03-windows-acl-coverage.md`.

- [ ] Make relayer and MCP security suites mandatory on Windows with no relevant skips.
- [ ] Record every sensitive file type, shared helpers, pre-write status, repair behavior, cleanup, and Windows test.
- [ ] Run both complete package suites, audits, package dry-runs, and `git diff --check`.
- [ ] Commit and push the remediation to PR #24; inspect exact Windows evidence and update the PR without merging.

## Self-Review

The tasks cover the two confirmed Blockers and two Majors: exact SID allowlisting, pre-write security, repair-before-read, cleanup, relayer/MCP coverage, and mandatory Windows evidence. All downstream modules consume the interfaces defined by Task 1; no second ACL implementation is introduced.
