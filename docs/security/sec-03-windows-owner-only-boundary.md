# SEC-03 Windows owner-only persistence boundary

> **Status: SEC-03 CLOSED.** Merged in
> [PR #24](https://github.com/papmilan/noosphere/pull/24), merge commit
> `33c2737e9e7171482c908a8753f951b7cd694969` (approved repaired head
> `5a405c9f5e8a9f2b10ee55fb5489715282e51290`). Post-merge CI on the merge commit
> is green across `noosphere-mcp`/`noosphere-relayer` on Windows, Ubuntu, and
> macOS; the exact-head approval evidence is CI
> [run 30026543705](https://github.com/papmilan/noosphere/actions/runs/30026543705)
> and deploy verification
> [run 30026543758](https://github.com/papmilan/noosphere/actions/runs/30026543758)
> on the same SHA. Lifecycle-installed runtime packaging is verified by the
> distribution regression (see "Lifecycle distribution coverage" below). Residual
> assumptions (same-user TOCTOU, symbolic links under Developer Mode, active local
> administrator compromise, unsupported filesystem semantics) are accepted by
> design and tracked in
> [noosphere-relayer/SECURITY-FOLLOWUPS.md](../../noosphere-relayer/SECURITY-FOLLOWUPS.md),
> not open findings. SEC-05 is the next active security milestone; the repository
> is not public-ready while SEC-05 remains open.

## Identity and DACL policy

`@noosphere/secure-fs` invokes a fixed PowerShell/.NET helper with argv and
binary stdin; it never interpolates a shell command. The helper resolves
`WindowsIdentity.GetCurrent().User`, which is the SID attached to the current
process token. It has no account-name, `whoami`, locale, domain-name, or
environment-variable fallback.

The helper replaces inheritance and the file DACL with exactly three allow
ACEs, expressed and inspected as `SecurityIdentifier` values:

- the current process-token user SID;
- `S-1-5-18` (SYSTEM);
- `S-1-5-32-544` (BUILTIN Administrators).

Read-back enumerates every explicit and inherited access rule as a numeric SID.
It requires exactly one non-inherited `FullControl` allow ACE for each
allowlisted SID and rejects duplicates, deny ACEs, inherited ACEs, missing
entries, and every other grant SID. This is independent of localized account
display names.

## Persistence and legacy-read policy

For Windows writes the shared helper validates the contained ancestor chain,
creates an empty same-directory file with `CreateNew` and `FileShare.None`,
applies the protected DACL, reads it back, copies binary stdin through the
retained `FileStream`, calls `Flush(true)`, closes, revalidates the destination,
and atomically renames. Every failure removes the staging file without following
links. POSIX uses `O_CREAT|O_EXCL|O_NOFOLLOW`, mode `0600`, `fsync`, and a
same-directory rename.

Existing sensitive files use `readOwnerOnlyFile`: containment and the final
component are validated, the Windows DACL is replaced and verified while a
retained handle prevents replacement, and only then are bytes returned for
parsing. A repair or verification error returns no bytes.

## Coverage matrix

| Component | File type | Sensitive content | Read helper | Write helper | Secure before bytes | Repair before read | Failure cleanup | Windows test |
|---|---|---|---|---|---|---|---|---|
| Relayer credentials | credential fallback | API/private credentials | `readOwnerOnlyFileSync` | `atomicOwnerOnlyWriteSync` | yes | yes | staging removed; prior target retained | `windows-acl.test.js`, `owner-only-boundary.test.js` |
| Relayer DurableStore | durable receipts, pending work, exact state | state and request results | `readOwnerOnlyFile` | `atomicOwnerOnlyWrite` | yes | yes | staging removed; prior target retained | same |
| Relayer LocalMemory | local memories | project memory text | `readOwnerOnlyFile` | `atomicOwnerOnlyWrite` | yes | yes | staging removed; prior target retained | same |
| Relayer snapshots | immutable snapshots | exact state bytes | `readOwnerOnlyFile` | `atomicOwnerOnlyWrite` | yes | yes | staging removed; prior target retained | same |
| MCP ACP store | JSON/Markdown pair | handoff state and rendered kernel | `readOwnerOnlyFile` | `writeOwnerOnlyFileExclusive` | yes | yes | pair transaction rollback and temp cleanup | `windows-acl.test.js`, `owner-only-boundary.test.js`, `acp-store.test.js` |
| MCP ACP transaction | journal, `.new`, and `.backup` files | current/prior ACP state | `readOwnerOnlyFile` | exclusive/atomic shared helpers | yes | yes | journal-driven rollback; every staged file removed | same |
| MCP execution store | JSON and Markdown checkpoint temps/finals | execution cursor and work notes | `readOwnerOnlyFile` | `writeOwnerOnlyFileExclusive` | yes | yes | both temps removed; prior finals retained | `windows-acl.test.js`, `acp-execution-store.test.js` |
| MCP sync metadata | confirmation metadata | repository observation and sync authority | `readOwnerOnlyFile` | `atomicOwnerOnlyWrite` | yes | yes | staging removed; prior target retained | `windows-acl.test.js`, `acp-sync-metadata.test.js` |
| MCP quarantine | unique quarantine file | rejected remote state bytes | n/a (write-only evidence) | `writeOwnerOnlyFileExclusive` | yes | n/a | partial file removed | `owner-only-boundary.test.js`, `acp-sync-metadata.test.js` |
| MCP CSP | canonical/runtime state, migration and write backups | project state and runtime telemetry | `readOwnerOnlyFile` | `writeOwnerOnlyFileExclusive` | yes | yes | stale-write recovery and temp cleanup preserved | `windows-acl.test.js`, `csp-storage.test.js` |
| MCP environment migration | `.env` and migration backup | Walrus credentials and API token | `readOwnerOnlyFile` | exclusive/atomic shared helpers | yes | yes | backup and staging cleanup; old target retained | `windows-acl.test.js`, `credentials.test.js` |
| MCP relayer authority | approved-origin store | credential-release allowlist | `readOwnerOnlyFile` | `atomicOwnerOnlyWrite` | yes | yes | staging removed; prior target retained | `windows-acl.test.js`, `relayer-authority.test.js` |
| MCP installer | installed relayer `.env` | credentials and API token | `readOwnerOnlyFile` when copying a live source | `atomicOwnerOnlyWrite` | yes | source repaired | staging removed; prior target retained | lifecycle suite plus shared boundary tests |

PID/token lock files and execution generation counters contain only process and
serialization metadata, not secret/state payloads; they retain their existing
exclusive lock implementation. This non-sensitive classification is authoritative
for execution generation counters. Git excludes, adapters, service definitions,
and public protocol/config scaffolding are not sensitive persistence.

## Stable failure behavior

SID, mutation, read-back, broad-DACL, incomplete-write, containment, reparse,
exclusive-create, and staging errors are surfaced with stable `state-*` codes.
The default Windows adapter maps missing PowerShell or unclassified helper
failures to `state-acl-failed`. The security suite forces SID, tool/mutation,
read-back, extra-ACE, write/incomplete, repair, and rename failures and verifies
that no staged file or newly disclosed secret remains.

## Lifecycle distribution coverage

The lifecycle-installed MCP runtime copies the canonical
`@noosphere/secure-fs` package into its own `node_modules/@noosphere/secure-fs`
directory, including `windows-owner-only.ps1`. A sibling package copy is also
kept under the installation app root so the relayer's locked `file:` dependency
resolves during its production `npm ci`; the installed relayer then resolves its
own package copy. The distribution regression installs packed artifacts, makes
the packed MCP source unavailable, imports the installed secure-fs boundary,
starts the installed MCP CLI and relayer, and verifies that the PowerShell helper
is resolved inside the installed tree. POSIX imports bundle but do not execute
the PowerShell helper.
