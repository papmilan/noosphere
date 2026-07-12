# ADR 0001: Separate ACP Runtime Project State from JSON Envelopes

- **Status:** Accepted
- **Date:** 2026-07-12
- **Decision owners:** Noosphere maintainers
- **Related specification:**
  `docs/superpowers/specs/2026-07-12-acp-continuity-kernel-design.md`

## Context

ACP exchanges a Project State Envelope as JSON. JSON is necessary at the
protocol boundary because it is portable, inspectable, storage-neutral, and
supported by every target agent environment. Those properties do not make a
decoded JSON object a safe domain model.

Input JSON is untrusted syntax. It can contain unsupported versions, duplicate
semantic identifiers, invalid timestamps, forged repository bindings,
dangling references, incompatible active decisions, excessive content, or
fields that ACP forbids. JavaScript objects produced by `JSON.parse` also
provide no type or invariant guarantees. Passing them directly through merge,
trust, and rendering code would force every function to repeat validation and
would make partially valid states representable inside the runtime.

ACP therefore needs a boundary between its wire representation and the state
on which its rules operate.

## Decision

ACP uses two representations:

1. **WireEnvelope** is the JSON-compatible protocol and persistence model.
   It preserves the public ACP schema exactly and contains no runtime-only
   indexes or environment observations.
2. **ProjectState** is the validated internal domain model. It is created only
   through ACP constructors and decoders, is immutable to callers, and cannot
   represent a structurally invalid envelope.

The runtime API is organized around explicit boundaries:

```text
unknown JSON
  -> decodeEnvelope(input, policy)
  -> Result<ProjectState, ValidationError[]>

ProjectState + Update + ObservedRepository + Clock
  -> applyUpdate(...)
  -> Result<ProjectState, Conflict[] | ValidationError[]>

ProjectState
  -> encodeEnvelope(state)
  -> WireEnvelope

ProjectState + Compatibility
  -> renderKernel(...)
  -> bounded Markdown
```

`ProjectState` is not required to be a JavaScript class. ACP v1 will implement
it as frozen, normalized values plus private derived indexes. Callers receive
pure operations rather than mutable fields. This avoids class serialization
semantics becoming part of the protocol.

## Why JSON Is Not the Domain Model

- JSON proves only that input is syntactically parseable.
- JSON Schema validates shape, not all cross-field or repository invariants.
- Wire compatibility requires accepting versioned representations that the
  current runtime may need to migrate before use.
- Domain operations need indexed assertions, active-decision lookup,
  provenance lookup, and conflict detection that do not belong on the wire.
- Trust and Git compatibility are partly derived from the current environment;
  persisting those derived conclusions as authoritative would make them stale.
- Allowing arbitrary decoded objects into domain functions makes invalid
  intermediate states observable and undermines deterministic behavior.

JSON remains the canonical interchange format. It is a boundary DTO, not the
object on which ACP business rules operate.

## Why a Separate Runtime State Is Required

The runtime state has three jobs that the envelope cannot safely perform:

1. **Establish validity once.** Domain functions may assume the structural and
   cross-field invariants listed below instead of defensively rechecking every
   property.
2. **Hold derived views.** Runtime indexes map stable IDs, decision domains,
   provenance references, active lifecycle items, and conflicts without
   changing the serialized protocol.
3. **Combine state with observations.** Repository compatibility, expiry at a
   supplied time, and effective trust depend on explicit environment inputs.
   They are computed views, not permanent facts about the envelope.

Runtime-only data includes:

- assertion and reference indexes;
- the active assertion set after supersession and expiry;
- decision-domain and priority indexes;
- detected unresolved conflicts;
- repository compatibility against the observed checkout;
- effective trust after freshness downgrades;
- validation diagnostics and migration provenance.

Runtime-only data is never included in the snapshot digest unless it is first
promoted to a defined wire field by a future schema version.

## ACP Invariants

A `ProjectState` exists only when all mandatory invariants hold.

### Identity and version

- `protocol` equals `acp.project-state-envelope`.
- `schema_version` is supported or has been migrated by a registered,
  deterministic migration.
- `snapshot_id` matches the digest of the canonical digest payload.
- `parent_snapshot_id` is absent or differs from `snapshot_id`.
- Stable IDs are unique within their typed collection.

### Time

- All timestamps use normalized UTC RFC 3339 form with millisecond precision.
- `expires_at`, when present, is not earlier than `created_at`.
- Expiry is evaluated using a `Clock` value supplied to the operation; domain
  functions never read wall-clock time implicitly.

### Repository binding

- `project_id`, repository identity, and workspace fingerprint are non-empty
  normalized values.
- Repository observations are captured locally; an agent cannot elevate trust
  by asserting its own compatibility result.
- Foreign repository state cannot become actionable runtime state.
- Diverged or advanced repository state deterministically downgrades affected
  assertions according to the compatibility policy.

### Assertions and provenance

- Every assertion has a supported type, stable ID, confidence, creation time,
  and bounded externally shareable text.
- `supersedes` cannot contain the assertion's own ID.
- Internal provenance references resolve to known reference or evidence IDs.
  External references declare their URI or repository locator explicitly.
- Expired or superseded assertions remain historical but cannot appear in the
  active set.
- Important decisions without evidence remain representable only with an
  explicit unverified trust downgrade.

### Plans, decisions, and conflicts

- Priorities are positive integers; lower values mean higher priority.
- Two incompatible active decisions in the same decision domain cannot be
  exposed as one settled decision. They create an unresolved conflict.
- Competing priority-1 next actions create an unresolved conflict.
- High-impact unresolved conflicts render before ordinary next actions.
- No ACP operation invents a compromise or chooses a winner without an
  explicit resolution update and provenance.

### Privacy and boundedness

- Hidden reasoning, chain-of-thought, token traces, secrets, credentials, and
  provider-internal state are not valid Project State.
- Text and collection sizes remain within schema and policy limits.
- Extensions use namespaced keys and pass the same recursive forbidden-field,
  control-character, and size validation as core fields.

## What Counts as Project State

Project State is externally shareable information required for another agent
to continue project work correctly:

- project and current objectives;
- success conditions and current phase;
- active plan and completed work;
- externally stated architectural and implementation decisions;
- evidence and provenance supporting those decisions;
- assumptions, unknowns, rejected approaches, blockers, and risks;
- explicit decision conflicts and resolution status;
- operational working stance: confidence, momentum, risk posture, attention,
  dissatisfaction with named approaches, and desired successor behavior;
- prioritized next actions;
- repository identity, revision, workspace fingerprint, and lineage;
- bounded references to relevant files, commits, tests, journal entries,
  memories, and external sources;
- ownership, permission scope, expiry, origin, integrity, and trust metadata.

Project State must be actionable, attributable, and safe to show to a human
collaborator.

## What Does Not Count as Project State

The following remain outside ACP Project State:

- raw chat history or the assistant's last response;
- private chain-of-thought, hidden reasoning, token traces, or model internals;
- simulated emotions or claims of consciousness;
- credentials, secrets, personal data unrelated to project continuation, or
  unrestricted environment variables;
- raw source trees, binary artifacts, complete diffs, or complete command
  logs; ACP references them when needed;
- unfiltered semantic-recall results;
- UI state, editor layout, cursor position, or screenshots unless a separate
  project requirement makes one an explicit evidence artifact;
- model-provider session state, caches, logits, or tool implementation state;
- derived runtime indexes, compatibility classifications, and effective trust;
- speculative statements with no declared status, confidence, or provenance.

Pinned user prompts remain authoritative project intent in Noosphere. ACP
references them and extracts only current actionable state; it does not replace
or silently rewrite the user's exact instruction.

## Determinism

ACP guarantees deterministic mechanics, not deterministic model judgment. Two
models may propose different updates. Given the same validated state and the
same explicit inputs, ACP must produce byte-identical results.

The guarantee is:

```text
transition(ProjectState, Update, ObservedRepository, Clock, Policy)
    -> identical ProjectState or identical ordered errors/conflicts

encode(ProjectState, Policy)
    -> byte-identical canonical JSON

render(ProjectState, Compatibility, Policy)
    -> byte-identical bounded Markdown
```

ACP achieves this by:

- passing repository observations, time, and policy as explicit inputs;
- prohibiting implicit wall-clock, random, locale, network, and model calls in
  validation, transition, encoding, and rendering;
- normalizing Unicode to NFC and line endings to LF;
- normalizing timestamps to UTC with millisecond precision;
- using RFC 8785 JSON Canonicalization Scheme semantics for digest input;
- sorting set-like collections by stable type and ID while preserving order
  only where the schema declares order semantically meaningful;
- assigning deterministic error and conflict ordering;
- using explicit priority, severity, and stable-ID tie-breakers in rendering;
- excluding snapshot and integrity fields from their own digest payload;
- making migrations pure functions from one supported wire version to the
  next;
- testing with clocks, repository observations, and policy fixtures.

The implementation must not claim that extraction from free-form text is
deterministic. Model-assisted extraction is a future, replaceable producer of
candidate updates; all such updates still pass through the deterministic ACP
runtime boundary.

## Consequences

### Positive

- Invalid JSON cannot leak into merge or rendering as partial domain state.
- Wire evolution does not force protocol DTOs to become runtime APIs.
- Storage backends remain unaware of Noosphere's internal indexes.
- Pure transitions are straightforward to test across platforms.
- Deterministic fixtures can serve as the foundation for an open conformance
  suite.
- Future language implementations can use different runtime structures while
  producing identical protocol results.

### Costs

- Every read and write crosses an explicit decode/encode boundary.
- The implementation maintains wire types, domain constructors, and mapping
  code separately.
- Cross-field validation and canonicalization require more tests than direct
  JSON manipulation.
- Runtime indexes must be rebuilt after loading rather than persisted as
  authoritative state.

These costs are accepted because ACP's value depends on safe interoperability,
not merely convenient local serialization.

## Rejected Alternatives

### Use parsed JSON directly

Rejected because it makes invalid intermediate states representable, couples
domain logic to wire evolution, and forces repeated validation.

### Make `ProjectState` a mutable class and serialize it

Rejected because class layout, mutation order, and language-specific behavior
would leak into the protocol and make cross-language conformance harder.

### Persist all runtime indexes

Rejected because indexes and compatibility are derived, can become stale, and
would create multiple sources of truth.

### Let renderers validate opportunistically

Rejected because different projections could accept different invalid states,
breaking ACP's cross-interface guarantees.

## Implementation Constraint

No ACP runtime code may be written until this ADR and the related design
specification are accepted. The implementation plan must map every domain
operation to these boundaries and include invariant and determinism tests.
