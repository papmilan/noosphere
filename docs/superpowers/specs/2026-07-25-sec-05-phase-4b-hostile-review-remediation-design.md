# SEC-05 Phase 4B hostile-review remediation

Status: approved for implementation on 2026-07-25.

Base implementation: `e3bb7b5` on `codex/sec-05-phase-4b`.

## Scope

Repair only the Phase 4B approval and format-selection defects proven by the
exact-head hostile review. Do not add Phase 4C migration, revocation, restore,
tombstones, or identity switching.

The repaired boundary must guarantee:

1. any format-2 binding-path state other than a genuinely absent path fails
   closed and cannot select format-1;
2. the bytes approved, hashed, committed, and later gated are byte-identical;
3. the terminal shows a complete injection-safe, byte-faithful representation
   of the approved source as well as the normalized text agents will consume;
4. only an exact confirmation line is accepted;
5. no trust-store file or lock is created before confirmation;
6. the production CLI remains the only reachable minter and succeeds through a
   genuine PTY, never through piped standard I/O.

## Design

### Raw source boundary

`slot-sources.js` will read source files as `Buffer` values before decoding.
Authority-capable source files are textual, so malformed UTF-8 will be rejected
instead of being decoded with replacement characters. This prevents distinct
byte sequences from collapsing to the same JavaScript string.

For valid UTF-8, the resolver will return both:

- `bytes`: the exact derived bytes to hash and commit;
- `text`: the decoded source used by the existing renderers.

Master-prompt and instructions bytes are the exact file bytes. Baseline keeps
the established header-removal and trimming policy; its derived `text` is
encoded once and those derived bytes become the sole approval and sink input.
Compatibility helpers may continue returning text, but must delegate to this
single source derivation.

### Approval display

The approval screen will contain two explicitly different views:

- a complete byte-faithful escaped representation in which every unsafe or
  non-ASCII byte is represented as `\xHH`;
- the normalized sink rendering that agents will receive.

The source path will use the same safe escaping so a hostile project path cannot
inject terminal controls. The screen will label `rawHash` as the SHA-256 of the
derived raw bytes and `contentHash` as the SHA-256 of the normalized sink text.
No raw untrusted control or Unicode formatting character will be written to the
terminal.

### Confirmation and sequencing

The production confirmation reader will compare the line returned by
`readline` directly with:

`approve <slot> <rawHash[0:8]>`

It will not trim, case-fold, normalize, or accept prefixes. Input will be
bounded; exceeding the bound aborts approval.

The operation order will be:

1. validate slot;
2. require TTY stdin and stdout;
3. derive and retain the exact source bytes;
4. display the safe byte representation, sink rendering, and hashes;
5. receive exact confirmation;
6. only then open/create the store, binding, machine key, recovery lock, and
   transaction state;
7. recover fail-closed and commit the retained bytes;
8. verify authority before printing success.

Decline, EOF, interruption, or malformed input before step 6 leaves the trust
home absent.

### Format selection

The read dispatcher will use a tri-state binding probe:

- `ENOENT`: format-2 binding is genuinely absent, so format-1 may govern;
- any existing filesystem object: format 2 governs and secure parsing decides;
- any other lookup error: fail closed.

A symlink, directory, unreadable path, malformed file, or unsupported binding
therefore cannot cause a format-1 downgrade.

### CLI grammar

The trust command will parse the complete argument list. After removing the
single supported global `--path <value>` pair, it must contain exactly:

`approve <master-prompt|instructions|baseline>`

Unknown options, aliases, `--`, missing values, and extra positional arguments
will fail before approval. Invalid invocation, owner refusal, and internal
failure will use distinct exit statuses.

## Tests

Regressions will be written and observed failing before production changes:

- symlink, directory, and lookup-error binding states cannot authorize legacy
  format-1 bytes;
- two distinct malformed UTF-8 files cannot retain one approval;
- the displayed escaped representation round-trips to the exact committed
  bytes and contains no raw terminal-control or bidi characters;
- leading/trailing whitespace, tabs, case changes, suffixes, and overlong input
  are rejected;
- decline leaves no machine key, binding, lock directory, or trust root;
- extra CLI arguments and option-looking slots are rejected;
- a real PTY drives the production CLI through successful approval, followed by
  exact-byte acceptance and changed-byte refusal;
- existing crash, recovery, project-binding, sink, format-1 compatibility,
  package-boundary, continuity, Ollama, and distribution suites remain green.

The PTY success test will run on Linux and macOS, but not through the same
facility: Linux drives util-linux `script` directly, while macOS needs system
`expect` to give BSD `script` a controlling PTY. Windows will continue to
exercise the service, CLI refusal, secure filesystem, and crash paths; the
POSIX-only PTY harness will be explicitly skipped there.

## Accepted residuals

Phase 4B continues to accept:

- a same-user adversary capable of driving and observing a PTY;
- deletion of format-2 state inside the owner-only trust root causing fallback
  to older owner-approved format-1 bytes;
- reduced Windows directory-entry durability already documented by SEC-05.

These residuals do not permit new attacker-chosen authority. Format-1 retirement
remains Phase 4C work.
