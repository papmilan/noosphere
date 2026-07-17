# Security Policy

Noosphere handles delegate private keys, API tokens, and project memory.
Security reports are taken seriously and handled privately.

## Supported versions

Only the latest published release of each package receives security fixes.

| Package | Supported |
| --- | --- |
| `noosphere-continuity` | 2.3.x |
| `noosphere-relayer` | 2.1.x |

Older versions do not receive backported fixes. Upgrade to the latest
release before reporting an issue you can only reproduce on an old version.

## Reporting a vulnerability

Report vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/papmilan/noosphere/security/advisories/new).

Do **not** open a public issue for a security problem, and do not include
working credentials or private keys in a report. Redacted examples are
enough.

A useful report includes:

- the package and version;
- the environment (OS, Node.js version, backend: local-file or Walrus);
- reproduction steps or a proof of concept;
- the impact you believe it has.

## What to expect

- Acknowledgement within **7 days**.
- An assessment (accepted, needs more information, or declined) within
  **14 days** of acknowledgement.
- Accepted reports are fixed in a patch release for every supported
  package, credited to the reporter unless anonymity is requested, and
  disclosed through a GitHub security advisory after the fix is published.

This project is maintained by a small team; the timelines above are
commitments to respond, not a 24/7 SLA.

## Scope

In scope:

- the `noosphere-continuity` and `noosphere-relayer` npm packages;
- the shared `@noosphere/acp-protocol` package vendored in this repository;
- credential storage and handling (`noosphere setup`, platform keychains,
  the owner-only fallback file);
- the relayer HTTP surface: authentication, CORS, rate limiting, and the
  ACP sync confirmation and quarantine mechanisms;
- ACP envelope validation, including the execution-checkpoint payload
  prohibition.

Out of scope:

- the Walrus Memory service, the managed relayer at
  `memory.walrus.xyz`, and the Sui network (report upstream);
- vulnerabilities requiring an already-compromised machine or root access;
- denial of service against a relayer you run on your own machine;
- issues only reproducible with `ALLOW_LOOPBACK_WITHOUT_TOKEN=true` on a
  loopback-only development instance, which is the documented local mode.

## Relayer origin approval (migration)

The API token (`NOOSPHERE_API_TOKEN`) is only sent to a **loopback** relayer or to
an origin the owner has explicitly approved. A relayer URL taken from project
configuration can never silently receive the token.

- Default (`http://127.0.0.1:3001`) and any loopback origin work with no extra
  step.
- A non-loopback relayer must use **HTTPS** and be approved once:

  ```
  noosphere approve-relayer https://relay.example.com
  ```

  Approvals are stored owner-only (mode `0600`) in
  `~/.noosphere/approved-relayers.json`. Until an origin is approved, requests to
  it fail closed and no token is sent. Origin-changing HTTP redirects on a
  credentialed request are rejected.

**Existing self-hosters:** if you previously set a non-loopback `relayer_url` or
`NOOSPHERE_RELAYER_URL`, run `approve-relayer` once for that origin after
upgrading. No token is transmitted until you do.

## Known limitations and hardening notes

These residuals are disclosed intentionally; they are not undisclosed defects:

- **DNS rebinding / SSRF via hostname.** Origin classification (loopback vs
  private/link-local vs public) is exact for literal IPs. A DNS hostname that
  resolves to a private address is treated as public — it still requires HTTPS
  and one-time approval — but the resolved address is not re-pinned. Approve only
  origins you control.
- **Same-user parent-swap TOCTOU.** State directories are verified with
  `lstat` + `realpath` containment and files are created with `O_NOFOLLOW`, which
  blocks symlinked directories, components, and files. A local attacker running
  as the same user who swaps a path component between the check and the write is
  not fully prevented, because fd-relative (`openat`) semantics are not available
  in the Node core API. This requires an already-local same-user attacker.
- **Windows filesystem behavior.** Junction/reparse-point containment was
  verified on commit `66a2e490cefd77a4aad0941d2c8869d89a4c14bc` with
  `PASS=4`, `FAIL=0`, and `SKIP=3`. The ACP Project State, Execution State,
  credential-store, and case-insensitive Project State junction scenarios all
  passed. The three symbolic-link scenarios were skipped because Developer Mode
  was unavailable. Junction containment is verified; full Windows symbolic-link
  coverage remains pending until a Developer Mode run. See
  [docs/security/windows-filesystem-verification.md](docs/security/windows-filesystem-verification.md).

## Security model

The documented trust boundary and data path live in
[docs/PRIVACY.md](docs/PRIVACY.md) and
[noosphere-relayer/MEMORY_SECURITY.md](noosphere-relayer/MEMORY_SECURITY.md).
Read them before reporting a boundary you believe is broken — some
boundaries (for example, the managed relayer seeing plaintext to build
embeddings) are documented design decisions, not leaks.
