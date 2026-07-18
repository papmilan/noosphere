# Continuation State Protocol (CSP) v1

## Status and purpose

This document is the normative specification for Continuation State Protocol
version 1. CSP is a small, durable snapshot of intentionally shared project
task truth. It is not an event log, journal, runtime telemetry format, remote
synchronization protocol, or replacement for ACP.

The canonical Git-tracked file is `.noosphere/state.json`. A Noosphere project
without that optional file remains valid. The ignored
`.noosphere/runtime-state.json` is an implementation record, not part of the
wire-compatible CSP document.

CSP answers only: what is the task status, what task is current, what happens
next, and what blocks progress. Git, agent, watcher, and timing observations
are deliberately excluded so committing CSP cannot make CSP describe a stale
HEAD and ordinary lifecycle operations cannot dirty tracked task state.

## Canonical schema

A CSP v1 document is UTF-8 JSON with exactly these fields:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/papmilan/noosphere/blob/main/noosphere-mcp/continuity/csp/schema.json",
  "title": "Noosphere Continuation State Protocol v1",
  "type": "object",
  "additionalProperties": false,
  "required": ["version", "status", "current_task", "next_action", "blocker"],
  "properties": {
    "version": { "const": 1 },
    "status": {
      "enum": ["not-started", "in-progress", "blocked", "done", "archived"]
    },
    "current_task": {
      "oneOf": [{ "type": "string", "minLength": 1, "maxLength": 1000 }, { "type": "null" }]
    },
    "next_action": {
      "oneOf": [{ "type": "string", "minLength": 1, "maxLength": 1000 }, { "type": "null" }]
    },
    "blocker": {
      "oneOf": [{ "type": "string", "minLength": 1, "maxLength": 1000 }, { "type": "null" }]
    }
  },
  "allOf": [
    {
      "if": { "properties": { "status": { "const": "blocked" } } },
      "then": { "properties": { "blocker": { "type": "string" } } }
    }
  ]
}
```

All strings must be valid UTF-8, NFC-normalized, bounded as above, and free of
C0/C1 control characters. CSP contains metadata only. Tokens, passwords,
cookies, API keys, SSH keys, environment variables, and secrets do not belong
in CSP. The schema is a whitelist; CSP v1 performs no value-pattern secret
detection.

`status == "blocked"` requires a non-null `blocker`. Leaving `blocked` does not
clear blocker text implicitly. A caller must clear it explicitly.

## Durable and runtime ownership

`.noosphere/state.json` owns only the five durable protocol fields. It changes
only through a meaningful task-state transition.

`.noosphere/runtime-state.json` remains Git-ignored and may contain watcher,
baseline, and checkpoint telemetry plus an internal `csp` observation object.
The current implementation records local fields such as:

```json
{
  "csp": {
    "revision": 3,
    "state_identity": "<SHA-256 of exact state.json bytes or null>",
    "observed_branch": "main",
    "observed_head": "<40 or 64 character Git object id>",
    "agent": { "vendor": "openai", "name": "codex", "version": null },
    "observed_at": "2026-07-18T20:10:00.000Z",
    "last_transition_at": "2026-07-18T20:00:00.000Z"
  }
}
```

This runtime shape is local implementation metadata, not an extension of the
CSP v1 protocol. Its revision is a local observation counter associated with
tracked file identities; it is not stored in or required to interpret the
shared document.

Resume, checkpoint, journal, Git HEAD changes, branch changes, and agent
changes may refresh ignored runtime observations. They must not rewrite
tracked CSP merely because those observations changed.

## State machine and transitions

Generic transitions may follow these edges:

```text
not-started -> in-progress | archived
in-progress -> blocked | done | archived
blocked     -> in-progress | done | archived
```

`done` and `archived` are terminal for generic status assignments:

```text
done     --reopen-->  in-progress
archived --restore--> in-progress
```

A transition may retain the current status while changing `current_task`,
`next_action`, or `blocker`. A transition that produces byte-equivalent task
truth is a no-op and does not rewrite the tracked file.

The transition layer is the sole tracked CSP mutation boundary. Public APIs
load, validate, merge, transition, record local runtime observations, and
render summaries; callers never replace the canonical file directly.

## Optimistic concurrency

Tracked CSP concurrency does not depend on Git HEAD or runtime metadata. Each
transition loads a validated base document and records the SHA-256 identity of
its exact source bytes. Under the exclusive CSP lock it reloads the current
document immediately before writing.

If file identity is unchanged, the proposed durable transition is validated
and written. If identity changed, the implementation performs a deterministic
three-way merge of `(base, current, proposed)`. An ambiguous edit returns
structured conflicts and writes nothing. The atomic writer rechecks file
identity after flushing its temporary file and again at the commit boundary.
Every CSP writer participates in the exclusive transition lock; direct file
replacement is not a supported mutation API.

Writes use an exclusive owner-only temporary file within the validated
`.noosphere` filesystem boundary, flush the file, atomically rename it, and
flush the containing directory where supported.

## Merge semantics

Merge is pure and deterministic:

- Objects merge recursively by key.
- One-sided and identical two-sided changes are preserved.
- Different edits to the same scalar produce an explicit conflict.
- Arrays are atomic and never merge positionally.
- Keys unknown to the generic merger are preserved.
- A result with unresolved conflicts is never written.

Conflict output identifies the JSON path and base, current, and proposed
values. CSP v1 validation remains closed (`additionalProperties: false`), so
generic unknown-key preservation is for reuse by an explicitly registered
future schema and does not make unknown fields valid in v1.

## CLI

Canonical CSP commands are:

```sh
noosphere state
noosphere state show
noosphere state --json
noosphere state set status in-progress
noosphere state set current-task "Publish security patch release"
noosphere state set blocker "Waiting for maintainer approval"
noosphere state set blocker none
noosphere state next "Run npm publish"
noosphere state reopen
noosphere state restore
```

`--json` prints only the canonical five-field durable document. Human summary
output combines durable task truth with current Git and ignored runtime
observations plus bounded journal context.

CLI success, including a missing optional CSP document, exits `0`. Usage,
validation, migration, and transition conflicts exit `1`. In JSON mode a
transition conflict prints a structured object containing the path plus base,
current, and proposed values; diagnostics and deprecation warnings remain on
stderr. If durable state commits but ignored runtime observation fails, the
transition still exits `0` and reports that runtime failure as a warning.

ACP commands live under `noosphere acp state`. For one release cycle, the old
ACP forms `noosphere state validate|sync|push|pull|history|quarantine` remain
compatibility aliases and emit a deprecation warning without changing ACP
behavior.

## Automatic integrations and resume

Higher-level operations may request a tracked transition only when they have
an explicit, meaningful task-state change. Initialization, resume, checkpoint,
and journal operations do not infer or mutate task truth. Future release,
publish, and CI integrations must follow the same rule. CSP never infers
completion from Git, npm, CI, or journal prose.

`renderResumeSummary` combines, in order:

1. validated durable CSP task truth;
2. current observed Git facts and available ignored runtime metadata;
3. a bounded, sanitized, quoted journal excerpt as human context.

When CSP exists, journal prose is never parsed into machine state.

## Runtime telemetry migration

Before CSP, `.noosphere/state.json` held ignored watcher, baseline, and
checkpoint telemetry. On first upgraded access:

1. A document valid under the five-field CSP v1 schema is left untouched.
2. Recognized legacy telemetry is linked to
   `.noosphere/runtime-state.json` without overwriting any destination, then
   detached from the legacy path only after its exact identity is rechecked.
3. Byte-identical telemetry at both paths retains the runtime copy and removes
   only the duplicate legacy path.
4. Corrupt, ambiguous, or differing files fail closed and are not overwritten.

After migration, Noosphere does not automatically create tracked CSP. An
explicit task transition creates it. Noosphere never stages it automatically.
The upgrade also replaces Noosphere's exact local ignore for `state.json` with
one for `runtime-state.json`; unrelated ignore rules are preserved.

## Compatibility and extension policy

- Missing CSP loads as `null`; an explicit transition may create it.
- Invalid JSON, UTF-8, schema versions, fields, or strings fail closed.
- CSP v1 readers support only version 1 and never rewrite an unsupported
  future version.
- A new top-level field requires a new schema version.
- Future schemas must preserve every valid v1 document.
- Runtime metadata and ACP remain independent of the shared CSP schema.

## Example

```json
{
  "version": 1,
  "status": "blocked",
  "current_task": "Publish security patch release",
  "next_action": "Run npm publish",
  "blocker": "Waiting for maintainer approval"
}
```

This document remains true after it is committed because it contains no claim
about the commit that contains it.
