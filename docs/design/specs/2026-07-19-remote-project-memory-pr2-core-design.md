# Remote Project Memory PR 2 Core Design

## Status

Approved for implementation on the isolated `codex/remote-project-memory-core`
branch. PR 2 follows the merged contracts-and-architecture PR without changing
existing Noosphere packages.

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

The in-memory repository remains the persistence seam. PR 2 extends it to
perform all required owner-scoped reads and atomic lifecycle mutations, while
preserving its collision-safe tuple storage, immutable checkpoint IDs, strictly
linear history, and operation-scoped idempotency receipts. A future PostgreSQL
implementation must preserve each observable result and make each multi-record
mutation one transaction.

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
in-memory implementation. It never affects another owner, including where IDs
are identical.

Session lifecycle is also `status` only. Creating a session sets `active`.
Explicit transitions allow `active`, `paused`, `interrupted`, `completed`, and
`archived`; all transition requests update that session's `updated_at`, and only
the owning project may contain it.

Every successful project mutation updates `updated_at` and `last_activity_at`.
Creating or transitioning a session also advances the containing project's
`updated_at` and `last_activity_at`. A committed checkpoint advances the
containing project timestamps and `latest_checkpoint_id`, and advances the
linked session's timestamps and `latest_checkpoint_id` when the checkpoint has
a session. The injected clock supplies UTC RFC 3339 timestamps, so these rules
are deterministic in tests. A failed mutation or a deduplicated successful
retry does not advance timestamps.

## Matching

Names and aliases are normalized by Unicode normalization, trimming, collapsing
whitespace, and lowercasing. The persisted `normalized_name` is computed by the
service, never trusted from a public create or update input.

`findProjects` first recognizes an exact project ID, exact normalized name, or
exact normalized alias. It resolves only when that tier has exactly one active
candidate. Otherwise it performs bounded normalized substring matching against
name and aliases, orders candidates by descending `last_activity_at` and then
ascending ID, and returns `ambiguous` for two or more candidates. A single
substring candidate is returned as `resolved`; zero candidates return `none`.
All queries are bounded and owner-scoped. The service never substitutes a
"latest" project or selects one of multiple plausible candidates.

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

`resumeProject` obtains the latest checkpoint and latest session activity. It
returns `fresh` when a durable checkpoint covers all session activity,
`stale` when a non-interrupted session has later activity, and `incomplete` when
there is no checkpoint or the latest session is interrupted. Warnings are
bounded, stable public objects. This implementation corrects the existing
contract parity gap so freshness values and warning codes emitted by the core
are accepted by the published MCP output schema.

`getProjectSummary` is a bounded projection: project identity and lifecycle,
the latest checkpoint's current status when present, counts, and head ID. It
does not return repository internals, transcripts, hidden reasoning, tokens, or
authentication metadata.

## Errors and safety

The service maps validation failures, missing owner-scoped records, ambiguity,
and repository conflicts to the published structured error model without
including owner identifiers, raw input, credentials, or private project names in
generic error messages. It treats every stored checkpoint field as untrusted
data on every read result.

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
