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

## Scope note

SEC-03 (filesystem symlink/path escape across the remaining state stores) and
SEC-05 (semantic-memory prompt/control injection) remain **open** and are not
addressed by the SEC-01 work. Per the security mandate, the repository is not
public-ready while SEC-03 remains open.
