# Relayer security follow-ups (post SEC-01)

The SEC-01 boundary (`relayer-origins.js`) closes repository-controlled selection
of a credential destination: a tracked config value (e.g. a committed `.env`
setting `MEMWAL_SERVER_URL`) can *request* an origin but can never *approve* one,
and the credential-bearing MemWal client is not constructed for an unapproved
origin. The following residuals are **explicitly out of scope** for that PR and
tracked here.

## SEC-01b — Same-origin redirect enforcement (public-release blocker)

**Residual.** The gate approves the *initial* configured origin. Once the MemWal
client makes a request, redirect handling happens **inside the
`@mysten-incubation/memwal` SDK's `fetch`**, which uses the default
`redirect: 'follow'` with no same-origin policy. A trusted-but-compromised (or
owner-approved-then-malicious) relayer could answer with a 307/308 cross-origin
redirect; undici forwards custom `x-*` headers and the request body on
307/308, so the request could be replayed against an unapproved origin.

**Why the private key is NOT transmitted.** Evidence: `@mysten-incubation/memwal`
`dist/manual.js` (~L617-634) signs each request with the Ed25519 delegate key
(`ed.signAsync(msgBytes, this.delegatePrivateKey)`) and sends
`x-public-key, x-signature, x-timestamp, x-nonce, x-account-id`. The private key
is used locally to sign; it is never placed in a header, body, or URL. A redirect
therefore cannot exfiltrate the private key.

**What may still traverse a redirect.** A **request-scoped** signature, the
`x-account-id`, and the request body — for `remember` that body is the memory
text being stored; for `recall` it is the query. The signature is bound to a
specific timestamp/nonce/message, so it is not a reusable bearer, but the
payload/query is sensitive.

**Why it is a public-release blocker.** A fully closed SEC-01 must guarantee that
credential-bearing (signed) traffic and its payload never reach an origin the
owner did not approve, even via a redirect from an approved origin.

**Expected implementation boundary.** Wrap the client's `fetch` (or pass a
`redirect: 'error'` / manual-redirect policy) so that: redirects are not
auto-followed across origins; any redirect whose `Location` resolves to a
different normalized origin than the approved one is rejected before the request
is re-sent; same-origin redirects (if any) re-pass the SEC-01 gate. This lives at
the SDK-fetch seam, not in `relayer-origins.js`.

## DNS-rebinding residual (future hardening, not a SEC-01 reopen)

**Current trust model.** The SEC-01 boundary is **hostname/origin based**. It does
not resolve DNS; it compares the normalized origin string against shipped
built-ins and the owner-only `~/.noosphere/relayer-origins.json`.

**Residual.** An origin that is a built-in or that the owner has already approved
could have its hostname resolve (or be rebound) to a private/loopback/link-local
IP, and the boundary would not detect it, because resolution is not part of the
decision.

**Why it does NOT reopen the repository-controlled exploit.** A repository cannot
add an approved hostname — approval comes only from shipped built-ins (whose DNS
the attacker does not control) or the owner-only global file (outside the repo
tree). Triggering this residual requires either compromising a trusted relayer's
DNS or the owner having already approved an attacker-controlled hostname. It does
not let tracked project config select a destination, which is the SEC-01 threat.

**Why future, not this PR.** Closing it requires resolve-and-pin or blocking
hosts that resolve to private ranges — a networking-layer change orthogonal to the
origin-approval boundary. Track alongside SEC-01b as public-release hardening.

## SEC-03 — filesystem boundary coverage inventory

All state stores route filesystem access through the single boundary in
`secure-fs.js` (`ensureContainedDir` / `ensureRealDirectoryPath` for directories,
`writeFileNoFollowSync` / `readFileNoFollowSync` / `readContainedStateFile` for
files). Coverage after SEC-03 increment 2:

| Store / path | Write path | Read path |
| --- | --- | --- |
| Snapshot backend (`snapshot-backend.js`, ACP Project + Execution **state bytes**) | `ensureContainedDirFor` + O_EXCL temp + non-following rename | `readSnapshotNoFollow` (O_NOFOLLOW) |
| `DurableStore` (`durable-store.js`, ACP exact-state **index** / receipts / pending) | `ensureRealDirectoryPath` (full chain) + non-following rename | `readContainedStateFile` (full chain + O_NOFOLLOW) |
| `LocalMemoryStore` (`local-memory.js`, local memory) | `ensureRealDirectoryPath` (full chain) + non-following rename | `readContainedStateFile` (full chain + O_NOFOLLOW) |
| Fallback credentials (`credentials.js`) | `ensureContainedDirSync` (full chain) + `writeFileNoFollowSync` | `assertContainedChainSync` (full chain) + `readFileNoFollowSync` |
| Approved relayer origins (`relayer-origins.js`) | owner-managed | `readFileNoFollowSync` |

**Reader/writer symmetry (increment 3).** Reads and writes now enforce the
**identical** containment policy through one traversal (`walkContained` /
`walkContainedSync` in `secure-fs.js`): the writer calls it with `create:true`
(`ensureContainedDir` / `ensureContainedDirSync`), the reader with `create:false`
(`assertContainedChain` / `assertContainedChainSync`). Both walk **every** segment
from the trusted root to the parent directory, reject any symlinked or
non-directory component (`state-dir-symlink` / `state-dir-not-directory`), and
`realpath`-verify containment at each level; the reader additionally opens the
final component `O_NOFOLLOW`. There is no longer a stronger writer or a weaker
reader.

**History.** Increment 1 stated the ACP project/execution state was contained once
the snapshot backend was hardened; that was incomplete — the exact-state *index*
persists via `DurableStore`, whose `load()` followed symlinks. Increment 2 routed
the loads through a no-follow read, but validated only the **immediate** parent, so
a symlinked **ancestor** still redirected reads outside the root (reproduced:
outside contents ingested as state). Increment 3 replaces the immediate-parent
check with the full-chain `assertContainedChain`, closing the ancestor gap and
making the reader identical to the writer, and applies the same to the credential
fallback read.

### Windows junction/reparse containment (closed by PR #24)

The Windows gap is now closed. The centralized `@noosphere/secure-fs` boundary
adds a fixed PowerShell/.NET owner-only helper: Windows writes exclusively create
a same-directory staging file, install and read back an exact three-SID DACL (the
token user SID, `S-1-5-18`, `S-1-5-32-544`) before any sensitive bytes, repair
existing sensitive files before reading them, and refuse directory junctions and
reparse points. Junction/reparse and owner-only ACL behavior is exercised by the
mandatory Windows CI suites (`noosphere-mcp` and `noosphere-relayer`
`windows-latest`) with no relevant skips. See
[docs/security/sec-03-windows-owner-only-boundary.md](../docs/security/sec-03-windows-owner-only-boundary.md).

- Merged in [PR #24](https://github.com/papmilan/noosphere/pull/24), merge commit
  `33c2737e9e7171482c908a8753f951b7cd694969` (approved repaired head
  `5a405c9f5e8a9f2b10ee55fb5489715282e51290`).
- Exact-head CI [run 30026543705](https://github.com/papmilan/noosphere/actions/runs/30026543705)
  and post-merge CI on the merge commit both green across Windows, Ubuntu, and
  macOS; deploy verification green on the same SHA.

### Accepted residual risks (not open SEC-03 findings)

- **TOCTOU / no `openat`.** Directory containment is validated by path, then the
  file is written by path; Node has no `openat`/dir-fd write, so a concurrent local
  attacker who swaps a validated directory for a symlink between the check and the
  write can still escape. Requires an active local same-user race with write access
  to the root's parent — not reachable by the static cloned-repo attacker. This is
  a documented, accepted-by-design limitation, not an open SEC-03 defect.
- **Windows symbolic links under Developer Mode.** The mandatory CI covers
  junctions/reparse points (the elevation-free primitive an attacker can create).
  The manual symbolic-link kit scenarios require Developer Mode and remain an
  accepted residual (unsupported/optional filesystem semantics), not an open
  finding. See
  [docs/security/windows-filesystem-verification.md](../docs/security/windows-filesystem-verification.md).
- **Operator-controlled roots.** An operator who points `NOOSPHERE_STATE_PATH` /
  `NOOSPHERE_SNAPSHOT_PATH` / `LOCAL_MEMORY_PATH` through a tree they themselves
  made a symlink is trusting their own configuration; this is operator trust, not
  the repository-controlled threat, and is out of SEC-03 scope.
- **Active local administrator compromise.** An attacker already running as a
  local administrator can rewrite ACLs and files directly; defending against an
  already-privileged local principal is outside the SEC-03 boundary.

## Scope note

**SEC-03 is CLOSED** as of PR #24 (merge commit
`33c2737e9e7171482c908a8753f951b7cd694969`): POSIX containment, Windows
junction/reparse containment, the Windows owner-only SID boundary,
repair-before-read, pre-write ACL enforcement, and lifecycle-installed runtime
packaging are all verified by mandatory Windows/Ubuntu/macOS CI. The items under
"Accepted residual risks" above are disclosed by design, not open findings.

SEC-05 (semantic-memory prompt/control injection) remains **open** and is the
active security milestone. Per the security mandate, the repository is **not
public-ready** while SEC-05 remains open.

## SEC-05 Phase 5 — replay-ledger release gate

The Phase 5 implementation candidate adds owner-local authenticated replay
evidence, production-reachable journal recovery, complete replay/candidate
identity separation, a global ranked replay–restore lock hierarchy, bounded
deterministic retention, typed suppression, and read-only inspection. Replay
classification remains independent from authority, and no relayer, MCP, HTTP,
hook, lifecycle, adapter, or package surface exposes a replay writer.

Replay-key reinitialization is deliberately omitted. A pristine root may create
one key; missing, replacement, or corrupt key material with any surviving replay
state fails closed without mutation. There is no reset, reinitialize, rotate,
repair, recovery, import, or export surface.

Local verification and the 26-mutant/conformance evidence are recorded in
[`docs/security/SEC-05-PHASE-5-VERIFICATION.md`](../docs/security/SEC-05-PHASE-5-VERIFICATION.md).
SEC-05 remains **open** and the repository remains **not public-ready** until
exact-head Linux, macOS, and Windows CI pass and an independent exact-head
hostile review reports no Critical or Important finding.
