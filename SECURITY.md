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

## Source approval (which project content is authoritative)

Project content is **data by default**. `.noosphere/master-prompt.md`,
`.noosphere/instructions.md` and the project baseline are rendered to agents as
quoted, non-authoritative text — a clone, an archive, a pull request, or an
injected agent cannot make them instructions. They become authoritative
instructions only when you approve their exact bytes yourself:

```sh
noosphere trust approve master-prompt
```

The command shows two deliberately different views before it can write trust
state:

- **Byte view:** a complete escaped representation of the derived source bytes;
  unsafe, non-ASCII, control, and backslash bytes appear as `\xHH`, so terminal
  controls and bidirectional formatting cannot disguise what is being hashed.
- **Agent view:** the normalized rendering agents will consume. The `rawHash`
  covers the exact derived bytes represented by the byte view; `contentHash`
  covers the normalized source text underlying the agent view.

Authority-capable sources must be valid UTF-8. Invalid UTF-8 is refused before
confirmation rather than decoded with replacement characters. The command is
interactive on purpose:

- it refuses unless both stdin and stdout are a TTY, which blocks ordinary piped,
  redirected, and scripted approval. Read the residual below before relying on
  this: a TTY check is **not** proof that a human is present;
- there is **no** `--yes`, environment variable, or config bypass;
- confirmation must equal `approve <slot> <first 8 hex of rawHash>` exactly and
  is bounded to 256 input bytes; whitespace changes, suffixes, EOF, and overlong
  input all refuse approval;
- the machine key, binding, recovery lock, and transaction state are not opened
  or created until after exact confirmation;
- approval binds the exact bytes — editing the file afterwards drops the slot
  back to quoted data until you approve it again;
- approvals are stored owner-only outside the project tree (under
  `~/.noosphere/trust-v2`), authenticated with a machine-local key, with an
  append-only audit chain.

Format-2 binding selection is fail-closed. Legacy fallback is possible only
when format-2 state is truly missing: the binding path is absent, or a securely
verified binding has no manifest for that slot. A symlink, directory, unreadable
or malformed binding, lookup error, or invalid manifest cannot select legacy
authority.

### Agent-facing ingress

Generated Claude, Codex, Gemini, and Cursor adapters do not tell agents to read
raw slot files as instructions. They run `noosphere context --local-only`, whose
output applies the same exact-byte format-2 authority decision as interactive
approval. The installed prompt hook uses that command too. Unapproved slot text
and all follow-ups are quoted as data; only an owner-authenticated exact slot is
emitted as authoritative. The command re-renders from bounded source reads
instead of trusting the repository-writable cached `context.md`.

### How project files are read

Everything Noosphere reads out of your working tree — the three source slots,
`.noosphere/journal.md`, `.noosphere/followups.jsonl`, `.noosphere/config.json`,
`.noosphere/context.md`, adapter files, and the git exclude file — goes through
one bounded read. That read opens with `O_NOFOLLOW` and `O_NONBLOCK`, checks the
opened file descriptor (not the path) with `fstat`, refuses anything that is not
a regular file, refuses anything over its size bound before allocating a byte,
and never reads more than that bound.

Consequences you can rely on:

- a FIFO, socket, or device at any of those paths fails immediately instead of
  blocking a refresh, a `watch`, or an approval forever;
- a huge file — including a sparse one, which costs an attacker nothing to
  create — is refused on its declared size, so it cannot exhaust memory;
- a file swapped for a different kind of object between the check and the open
  cannot change what is read, because the type and size are taken from the
  descriptor that was actually opened.

On Windows neither `O_NOFOLLOW` nor `O_NONBLOCK` exists, so the no-follow
decision is made by an `lstat` before the open and re-checked against the opened
descriptor's identity afterwards. A residual race remains there, and its maximum
impact is this: an attacker who can already write into your project tree, and who
swaps a symlink in and back out inside one microsecond-scale window, makes this
process read the bytes at the symlink's target instead of the file's. It cannot
make those bytes authoritative (approval binds exact bytes through a separate
interactive transition, and unapproved bytes render as quoted data), it cannot
exceed the size bound, and it grants no read that attacker did not already have —
the same identity could write those bytes into the file directly, with no race.
POSIX has no such window.

**Size bounds.** Source slots (`master-prompt`, `instructions`, `baseline`) are
bounded at **1 MiB**: they are human-authored markdown that you read in a
terminal before approving and that every agent then carries in its context, so a
megabyte is already far past anything usable. Other project files are bounded at
**8 MiB**, because `journal.md` and `followups.jsonl` grow legitimately over the
life of a project. Neither bound is configurable — a tunable security bound is a
downgrade switch.

**Symlink policy (compatibility change).** A slot file that **is** a symlink is
**rejected**: it is never followed and never opened, and the slot reports as
present-but-unusable. Before Phase 4B such a symlink was followed. The reason is
that the slot path is the one thing you are told you are approving; following a
symlink there would let `.noosphere/master-prompt.md` name bytes anywhere the
process can read while the displayed source path still said
`.noosphere/master-prompt.md`.

A slot file reached **through a symlinked parent directory** is **supported** and
read normally. That case redirects the whole project tree rather than one
authority-capable file, and it is ordinary infrastructure — macOS `/tmp` is a
symlink, as are many git worktrees, container mounts, and relocated home
directories. Anyone able to repoint a parent directory can equally rewrite the
file in place, and neither makes bytes authoritative: approval binds exact bytes
through a separate interactive transition.

If you were relying on a symlinked slot file, replace it with a real file (or
symlink the containing directory instead).

**How project files are written.** Every project file Noosphere rewrites —
`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.mcp.json`, `.gitignore`,
`.git/info/exclude`, and the files under `.noosphere/` — is written to a
temporary file beside it and then renamed over the target, never truncated in
place.

This matters because Noosphere reads the same files it rewrites, and
`noosphere watch` means a reader is usually running. A plain write truncates
first and fills afterwards, so it publishes an empty file for a moment; a reader
landing in that window reads zero bytes with no error, and the callers that read
a file, edit it, and write it back would then persist that emptiness — losing
whatever you had written. Renaming is atomic: a reader sees either the whole old
file or the whole new one.

If a write target is a symlink or not a regular file, the write is **refused**
rather than redirected, because renaming over a symlink would silently replace
the link itself. Unlike bounded reads, repository-managed writes and removals
also refuse symlinked parent directories. Replace a symlinked project file or
parent directory with a real path if you were relying on one for mutation.

When the caller supplies a project root, every descendant directory is checked
and a symlinked parent is refused before creating the temporary file. Existing
POSIX permission bits are copied to the replacement inode; new files use the
ordinary process umask. On Windows, an existing target's DACL is copied to the
temporary file before rename; if that copy fails, the original remains in place.
Journal and follow-up appends serialize a bounded read-modify-replace operation
with an exclusive sibling lock, so concurrent writers cannot lose entries or
jointly exceed the size bound. The 8 MiB journal ceiling is an intentional
security boundary and is not rotated automatically; archive or truncate the
journal explicitly before further appends. If a crashed writer leaves a lock,
the busy error names the exact `.append.lock` file; after confirming no writer
is active, remove that file manually. Repository-managed file and empty-directory
removal uses the same contained-parent and no-symlink policy instead of following
a redirected parent. Other file-specific metadata (for example, extended
attributes) is not promised to survive an ordinary project-file replacement.

**Present is not absent.** A slot that exists but cannot be read — corrupt UTF-8,
oversized, a directory, a FIFO, permissions revoked — is reported as
*present-but-unusable*, never as absent. It is non-authoritative, it does not
trigger restoration of remote content over your local file, and the shared
context renders an explicit fail-closed notice (naming the failure class, never
the file's bytes) instead of claiming you recorded nothing. `noosphere protocol`
applies the same rule in the other direction: absent, malformed, non-regular, and
unreadable instructions all exit nonzero with a diagnostic rather than printing
zero bytes and succeeding.

Accepted residuals:

- **the TTY gate does not prove human presence.** Any adversary who can run
  commands on your machine can allocate a pseudo-terminal (`script`, `expect`,
  `openpty`) and drive the approval. It does **not** need to observe the terminal
  output: the required phrase is `approve <slot> <first 8 hex of rawHash>`, and
  an adversary that planted or can read the slot file computes that hash offline.
  So the gate stops accidental and ordinary non-interactive approval, not a
  determined shell-capable attacker. Your terminal — and anything able to spawn
  processes as you — is the trust boundary. Closing this needs an OS-mediated
  presence proof (platform keychain, biometric, or re-authentication) that a
  child process cannot relay; that is **not** in Phase 4B and is an accepted
  residual of this phase;
- someone who can delete format-2 state inside the owner-only trust root and
  retained a legacy record can fall back to older **owner-approved** bytes. This
  never authorizes bytes you did not approve.

Phase 4B did not include Phase 4C migration, revocation, restore, tombstones,
identity switching, or retirement of the legacy format. Those authority and
restore controls are now implemented by Phase 4C.

## Replay-ledger boundary (SEC-05 Phase 5 release candidate)

Recalled semantic memory remains quoted, non-authoritative data. Phase 5 adds
owner-local replay evidence without expanding authority:

- replay identity contains only the authenticated project identity, trusted
  local slot, and normalized content digest;
- replay identity and random restore-candidate identity are separate domains
  with no persisted cross-reference;
- all replay/restore mutations follow the ranked lock hierarchy and recover
  authenticated incomplete replay journals before observing new content;
- a replay lock surviving process death is never guessed stale or deleted
  automatically: production retries fail closed until the owner independently
  confirms no operation is live and removes that lock, after which the normal
  production path performs authenticated journal recovery;
- multi-item typed refresh commits replay observations in response order so its
  fail-fast project lock cannot make the refresh contend with itself;
- ordinary duplicates stay visible and receive informational replay/freshness
  labels; typed restore may suppress only an already-matching authenticated
  local candidate;
- retention is fixed at 4,096 live records and 90 days and ignores remote
  timestamp, ranking, and metadata;
- `noosphere replay status` and bounded `replay list` are authenticated,
  byte-for-byte read-only inspection commands;
- replay writers and replay-key operations are absent from package exports,
  MCP, HTTP, hooks, lifecycle services, adapters, and the relayer;
- a missing or replaced replay key with surviving replay state fails closed.
  There is deliberately no replay-key reset, reinitialization, rotation,
  repair, recovery, import, or export operation.

Replay classification never changes `isSlotAuthoritative`, approval,
revocation, candidate application, or receipt state. Complete replay-root
deletion loses replay history and permits only a later pristine initialization;
this does not change content authority.

Phase 5 is not yet a closure claim. The exact-head Linux/macOS/Windows CI and
independent hostile-review gates are recorded as pending in
[the Phase 5 verification record](docs/security/SEC-05-PHASE-5-VERIFICATION.md).
Until those gates pass, SEC-05 remains open and the repository remains not
public-ready.

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
- **Windows filesystem behavior.** Windows junction/reparse-point containment and
  the owner-only three-SID DACL boundary (token user SID, `S-1-5-18`,
  `S-1-5-32-544`, with repair-before-read and pre-write ACL enforcement) are
  verified by **mandatory** CI on `windows-latest` for both packages, alongside
  the Ubuntu and macOS POSIX suites — merged in
  [PR #24](https://github.com/papmilan/noosphere/pull/24), merge commit
  `33c2737e9e7171482c908a8753f951b7cd694969`. Symbolic-link scenarios that require
  Developer Mode are covered only by the optional manual kit and remain an accepted
  residual, not an open finding. See
  [docs/security/windows-filesystem-verification.md](docs/security/windows-filesystem-verification.md)
  and
  [docs/security/sec-03-windows-owner-only-boundary.md](docs/security/sec-03-windows-owner-only-boundary.md).
- **Legacy approval fallback.** A slot with genuinely missing format-2 state
  still honours a legacy (pre-4B) approval record, so upgrades do not silently
  lose trust. Someone who can delete inside your owner-only trust directory and
  kept a superseded legacy record could therefore force a slot back to older
  **owner-approved** bytes; it never authorizes bytes you did not approve. The
  legacy format is not retired in Phase 4B.

## Security model

The documented trust boundary and data path live in
[docs/PRIVACY.md](docs/PRIVACY.md) and
[noosphere-relayer/MEMORY_SECURITY.md](noosphere-relayer/MEMORY_SECURITY.md).
Read them before reporting a boundary you believe is broken — some
boundaries (for example, the managed relayer seeing plaintext to build
embeddings) are documented design decisions, not leaks.
