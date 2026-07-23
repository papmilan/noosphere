# Windows filesystem containment verification (SEC-03)

The SEC-03 fix adds a centralized filesystem boundary (`secure-fs.js`) that
refuses to write Noosphere state, execution checkpoints, or credential files
through a symlinked or reparse-point directory. That boundary is verified on
POSIX (macOS/Linux) by the automated tests
(`noosphere-mcp/tests/secure-fs.test.js`,
`noosphere-relayer/tests/secure-fs.test.js`). Windows uses junctions and reparse
points with different semantics, so it must be verified separately on the exact
supported Windows versions before a Windows release is declared safe.

## What it checks

For each store, the kit turns the state directory into a symlink or junction
pointing at an outside directory that contains an inert sentinel file, then runs
the real branch code and asserts:

- the operation is **refused** by the containment guard, and
- **nothing** is written into the outside directory (sentinel-only), and
- the outside directory's permissions are **unchanged**.

Scenarios:

| Scenario | Link types |
| --- | --- |
| ACP Project State (`writeState`) | junction, symlink, case-insensitive (`.NOOSPHERE`) |
| Execution State (`writeExecutionState`) | junction, symlink |
| Credential fallback (`CredentialStore.setPassword`) | junction, symlink |

Junction (reparse-point) scenarios always run. Symbolic-link scenarios run only
when the shell can create symlinks; otherwise they are reported `SKIP`, never
`PASS`.

## Prerequisites

- Node.js — a supported version (see the table below).
- `git` on `PATH` (the Project State scenario runs `git init`).
- The branch checked out with dependencies installed:
  `npm --prefix noosphere-mcp ci` and `npm --prefix noosphere-relayer ci`.
- Optional, to cover symlink scenarios: **Developer Mode** enabled
  (Settings → Privacy & security → For developers) or an elevated PowerShell.
  Junctions do not require elevation.

## Exact command

From the repository root, in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify-secure-fs-windows.ps1
```

or on PowerShell 7+:

```powershell
pwsh -File scripts/verify-secure-fs-windows.ps1
```

## Expected output

A compact table, then a verdict line. A safe run looks like:

```
Noosphere SEC-03 Windows filesystem verification
repo root : C:\...\noosphere
symlinks  : available

Scenario                              Link         Refused Boundary Code               Sentinel Result
--------                              ----         ------- -------- ----               -------- ------
ACP Project State (junction)          Junction        True     True state-dir-symlink     True PASS
Execution State (junction)            Junction        True     True state-dir-symlink     True PASS
Credential store (junction)           Junction        True     True state-dir-symlink     True PASS
ACP Project State (case-insensitive)  Junction        True     True state-dir-symlink     True PASS
ACP Project State (symlink)           SymbolicLink    True     True state-dir-symlink     True PASS
Execution State (symlink)             SymbolicLink    True     True state-dir-symlink     True PASS
Credential store (symlink)            SymbolicLink    True     True state-dir-symlink     True PASS

PASS=7  FAIL=0  SKIP=0
RESULT: SAFE — all scenarios refused and contained.
```

Exit code is `0` when every executed scenario is SAFE, non-zero otherwise. Any
`FAIL` row — a store that wrote outside its root or did not refuse — means the
Windows behavior is unsafe and must be fixed before release. `Code` may also be
`state-dir-escape` (realpath-containment refusal) instead of `state-dir-symlink`
depending on how Windows reports the reparse point; both are safe refusals.

## Limitations when symlink creation is unavailable

Without Developer Mode or elevation, Windows refuses `SymbolicLink` creation.
The kit still runs all **junction** scenarios (junctions are the reparse-point
primitive an attacker can create without elevation, so they are the primary
Windows threat) and marks the symlink scenarios `SKIP`. A run with `SKIP` rows
verifies junction containment but does not cover symlink containment; enable
Developer Mode to get full coverage before declaring symlink safety.

## Automated Windows CI (SEC-03 closed)

SEC-03 is CLOSED as of
[PR #24](https://github.com/papmilan/noosphere/pull/24), merge commit
`33c2737e9e7171482c908a8753f951b7cd694969` (approved repaired head
`5a405c9f5e8a9f2b10ee55fb5489715282e51290`). Windows junction/reparse containment
and the owner-only three-SID DACL boundary now run in **mandatory** CI on
`windows-latest` for both `noosphere-mcp` and `noosphere-relayer`, with no
relevant skips, alongside the Ubuntu and macOS POSIX suites. Exact-head evidence
is CI
[run 30026543705](https://github.com/papmilan/noosphere/actions/runs/30026543705)
and deploy verification
[run 30026543758](https://github.com/papmilan/noosphere/actions/runs/30026543758);
post-merge CI on the merge commit is green across all three platforms. The
owner-only boundary detail lives in
[sec-03-windows-owner-only-boundary.md](sec-03-windows-owner-only-boundary.md).

The manual verification kit below predates PR #24 and remains useful for local
symbolic-link coverage under Developer Mode. Its skipped symbolic-link scenarios
are an **accepted residual** (optional/unsupported filesystem semantics requiring
Developer Mode), not an open SEC-03 finding.

## Completed Windows verification

Verification was completed on commit
`66a2e490cefd77a4aad0941d2c8869d89a4c14bc` (manual pre-PR#24 run).

| Windows version | Node version | Symlinks | Result | Date | Runner |
| --- | --- | --- | --- | --- | --- |
| Windows 10 Pro, Version 2009, build 19045 | v22.18.0 | Unavailable (Developer Mode disabled) | `PASS=4`, `FAIL=0`, `SKIP=3`; SAFE for executed scenarios | 2026-07-17 | Dell laptop; Windows PowerShell 5.1 |

Passed scenarios:

- ACP Project State (junction)
- Execution State (junction)
- Credential store (junction)
- ACP Project State (case-insensitive junction)

Skipped scenarios:

- ACP Project State (symbolic link)
- Execution State (symbolic link)
- Credential store (symbolic link)

All three symbolic-link scenarios were skipped only because Developer Mode was
unavailable. The completed run verifies Windows junction/reparse-point
containment, including the case-insensitive Project State scenario. It does not
establish full Windows symbolic-link coverage; that remains pending until the
same scenarios run with Developer Mode enabled.
