# Remote Project Memory PR 2 Core Design

## Status

Approved core design for the isolated `codex/remote-project-memory-core` branch.
PR 2 follows the merged contracts-and-architecture PR without changing existing
Noosphere packages. Implementation remains paused until this revision is
committed and a separate TDD implementation plan is approved.

## Goal

Make the versioned Project Memory contracts usable through a pure,
owner-scoped application service backed by the in-memory repository. The core
must support durable project, session, and checkpoint workflows for any kind of
project without requiring Git, a local directory, a local CLI, an HTTP listener,
or a user-run process.

## Boundary

PR 2 adds no remote MCP transport, HTTP endpoint, authentication verifier,
PostgreSQL driver or migration, deployment configuration, Docker image, OIDC
SDK, transcript capture, artifact storage, or change to `noosphere-mcp`,
`noosphere-relayer`, CSP, or ACP. Its `ownerScope` is trusted server context
supplied by a future authenticated request layer; it is never accepted in a
public tool input.

The service is deliberately a pure application boundary. PR 3 will replace the
in-memory storage port with transactional PostgreSQL and provide verified owner
identity. PR 4 will bind this core to Streamable HTTP MCP.

## Components

`ProjectMemoryService` owns use-case orchestration. It receives a repository,
an injected clock, and an injected identifier generator. Its public methods take
an internal `{ ownerScope, input }` command envelope, validate the public
`input`, and return only public-contract values.

The in-memory repository remains the persistence seam. It stores and retrieves
only values already normalized or projected by the service, and enforces
persistence invariants: owner scoping, collision-safe tuple storage, immutable
checkpoint IDs, strictly linear history, atomic multi-record mutations, and
operation-scoped idempotency receipts. It does not normalize names, choose a
matching policy, generate timestamps, or map persistence failures to public
errors. A future PostgreSQL implementation must preserve these observable
results and make each multi-record mutation one transaction.

The service owns deterministic normalization, matching, timestamp projection,
request hashes, summaries, and stable repository-error mapping. It does not
interpret stored text as instructions: any returned checkpoint-derived text is
marked `untrusted-persisted-data`.

## Operations and lifecycle

The core implements the contract operations for project creation/listing/getting
and finding; project update/archive/delete; session creation/getting/listing and
status transition; checkpoint save/get/latest/list; project resume; and project
summary.

Project lifecycle has one source of truth: `status`. `archive_project` changes
it to `archived`; normal lists and matching exclude archived projects unless
explicitly requested. An archived project remains readable by its owner and can
be resumed only when explicitly addressed. `delete_project` permanently removes
the owner's project, sessions, checkpoints, and idempotency receipts from the
in-memory implementation. The first owner-authorized delete succeeds. Any later
delete returns the generic public `not-found` outcome, indistinguishable from a
request to delete another owner's project or an ID that never existed. It never
affects another owner, including where IDs are identical.

Session lifecycle is also `status` only. Creating a session sets `active`; only
the owning project may contain it. The allowed state machine is:

| Current status | Allowed next statuses |
| --- | --- |
| `active` | `paused`, `interrupted`, `completed`, `archived` |
| `paused` | `active`, `interrupted`, `completed`, `archived` |
| `interrupted` | `active`, `completed`, `archived` |
| `completed` | `archived` |
| `archived` | none |

Same-state requests are idempotent no-ops: they return the existing public
session and do not advance either session or project timestamps. Any other
transition is invalid and changes neither record.

Every successful project mutation updates `updated_at` and `last_activity_at`.
Creating or transitioning a session also advances the containing project's
`updated_at` and `last_activity_at`. A committed checkpoint advances the
containing project timestamps and `latest_checkpoint_id`, and advances the
linked session's timestamps and `latest_checkpoint_id` when the checkpoint has
a session. The injected clock supplies UTC RFC 3339 timestamps, so these rules
are deterministic in tests. A failed mutation or a deduplicated successful
retry does not advance timestamps.

## Matching

Names, aliases, and queries use Unicode NFKC normalization, trimming,
whitespace collapsing, and lowercasing. The persisted `normalized_name` is
computed exclusively by the service and is never trusted from a public create
or update input. The repository stores the resulting values and never applies
normalization itself.

`findProjects` evaluates three exact-match tiers in order: exact project ID,
exact normalized project name, and exact normalized alias. It resolves only
when the current tier contains exactly one active candidate. A tier with more
than one candidate returns `ambiguous` and does not continue to a lower tier.

When no exact tier matches, the service performs bounded normalized substring
search against names and aliases. Substring search is discovery-only: zero
candidates return `none`; one or more candidates return `ambiguous` with the
bounded candidate list. It never silently resolves a partial-name search. All
candidate lists are owner-scoped and ordered by descending `last_activity_at`,
then ascending ID. The service never substitutes a "latest" project or infers
intent from a partial name.

## Pagination

List cursors are opaque values bound to the authenticated owner scope and to the
normalized query and filter set that produced them. A cursor presented with a
different owner, list operation, search/filter set, or malformed encoding is
rejected as an invalid argument. PR 2's in-memory repository does not promise
snapshot isolation: inserts or mutations between page requests may affect later
pages. For an unchanged dataset, ordering is deterministic and pages are
duplicate-free.

## Checkpoints, idempotency, and resume

Checkpoint saves require the referenced project and optional session to belong
to the same owner. The service computes the next revision and predecessor from
the project's committed head; callers cannot create branches, skip revisions,
or overwrite a checkpoint ID. The repository atomically commits the checkpoint,
project head, timestamp projection, linked-session projection, and idempotency
receipt.

Idempotency stays scoped to `(ownerScope, operation, idempotency key)`. The
service hashes a canonical representation of the public command input. A retry
with the same hash replays the committed success without timestamp changes; a
different hash produces `idempotency-conflict`; no receipt is committed for a
failed mutation. Retention/TTL stays explicitly deferred to the PostgreSQL
deployment configuration in PR 3.

`resumeProject` derives freshness from committed repository state, not timestamps
alone. Before projecting a result, it verifies that the Project head references
the owner-scoped checkpoint with the highest committed revision for that project;
that referenced checkpoint exists and belongs to the same owner and project; and
that each non-null Session head references an existing checkpoint in the same
owner and project. If the committed head checkpoint links a Session, that
Session's head must equal the Project head. Finally, the head checkpoint must
cover all later relevant session activity.

If any repository-head invariant is inconsistent, `resumeProject` returns an
`incomplete` result with `latest_checkpoint: null` and exactly one stable public
warning: `{ code: "repository-state-inconsistent", message: "The durable project
state is incomplete and cannot be safely resumed." }`. It must not disclose
identifiers, whether a row is missing, or other persistence details, and it must
never return `fresh`. A valid project with no checkpoint is also `incomplete`,
but uses the distinct `no-durable-checkpoint` warning. For consistent state,
`fresh` requires a durable checkpoint covering all relevant session activity;
`stale` means later non-interrupted session activity exists; and `incomplete`
means the latest relevant session is interrupted. Warnings are bounded, stable
public objects. This implementation corrects the existing contract parity gap
so freshness values and warning codes emitted by the core are accepted by the
published MCP output schema.

`getProjectSummary` is a bounded projection: project identity and lifecycle,
the latest checkpoint's current status when present, counts, and head ID. Every
field derived from persisted checkpoint content remains contained within a
result marked `content_trust: "untrusted-persisted-data"`; summary and resume
projections never turn stored content into instructions. The service never
returns repository internals, transcripts, hidden reasoning, tokens, or
authentication metadata.

## Errors and safety

The service maps validation failures, missing owner-scoped records, ambiguity,
and repository conflicts to the published structured error model without
including owner identifiers, raw input, credentials, or private project names in
generic error messages. Every response that includes persisted checkpoint-derived
data marks the enclosing object `content_trust: "untrusted-persisted-data"`.

## Test strategy

New `node:test` suites begin each behavior with a failing test. They cover
owner-scope isolation; no-local-environment operation; deterministic name/alias
matching and ambiguity; archive/delete filtering and cascades; session/project
timestamp and checkpoint-head updates; session/project consistency; checkpoint
revision, session, and idempotency behavior; stable pagination; fresh/stale/
incomplete resume outcomes; untrusted result marking; and Bicycle Repair plus
separate ESS Design continuity scenarios.

The PR retains the full PR 1 contract suite and runs ACP, relayer, package
dry-run, and diff checks before review. No compatibility claim for ChatGPT or
Claude is made; real-client validation remains PR 5 work.
