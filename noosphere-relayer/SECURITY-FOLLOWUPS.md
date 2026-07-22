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
| `DurableStore` (`durable-store.js`, ACP exact-state **index** / receipts / pending) | `ensureRealDirectoryPath` + non-following rename | `readContainedStateFile` (dir-validated + O_NOFOLLOW) — **secured in this increment** |
| `LocalMemoryStore` (`local-memory.js`, local memory) | `ensureRealDirectoryPath` + non-following rename | `readContainedStateFile` — **secured in this increment** |
| Fallback credentials (`credentials.js`) | `writeFileNoFollowSync` | `readFileNoFollowSync` |
| Approved relayer origins (`relayer-origins.js`) | owner-managed | `readFileNoFollowSync` |

**Correction to the increment-1 inventory.** Increment 1 stated the ACP
project/execution state was contained once the snapshot backend was hardened.
That was incomplete: the authoritative exact-state *index* persists via
`DurableStore`, whose `load()` used a follow-prone read with no directory
validation, so a pre-planted symlink at `NOOSPHERE_STATE_PATH` redirected the read
to an outside file (reproduced — outside contents were ingested as state). The
same defect existed in `LocalMemoryStore.load()`. Both read paths are closed in
this increment and now match their already-hardened write paths.

### Still open (SEC-03 remains open)

- **Windows junctions / reparse points.** `O_NOFOLLOW` is a POSIX-only flag
  (`fs.constants.O_NOFOLLOW` is `0` on Windows), and `lstat().isSymbolicLink()`
  does not reliably classify directory junctions or reparse points. On Windows the
  no-follow reads degrade to follow-prone and the directory-component check is
  weaker. **This keeps SEC-03 open.** Not addressed in this increment.
- **TOCTOU / no `openat`.** Directory containment is validated by path, then the
  file is written by path; Node has no `openat`/dir-fd write, so a concurrent local
  attacker who swaps a validated directory for a symlink between the check and the
  write can still escape. Requires an active local race with write access to the
  root's parent — not reachable by the static cloned-repo attacker. Removing the
  redundant `mkdir` in `atomicOwnerOnlyWrite` narrows but does not close the window.
- **Operator-controlled roots.** An operator who points `NOOSPHERE_STATE_PATH` /
  `NOOSPHERE_SNAPSHOT_PATH` / `LOCAL_MEMORY_PATH` through a tree they themselves
  made a symlink is trusting their own configuration; this is operator trust, not
  the repository-controlled threat, and is out of SEC-03 scope.

## Scope note

SEC-03 remains **open** until the Windows junction/reparse-point work is complete.
SEC-05 (semantic-memory prompt/control injection) remains **open** and is not
addressed here. Per the security mandate, the repository is not public-ready while
SEC-03 remains open.
