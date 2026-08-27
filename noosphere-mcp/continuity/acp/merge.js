import { createProjectState } from './project-state.js';
import { canonicalize, encodeEnvelope } from './wire.js';
import { unresolvedConflicts } from './render.js';

// V1 keeps only the current snapshot. An update that descends directly from the
// current snapshot fast-forwards. A concurrent (stale) update is merged
// conservatively: new distinct-ID assertions are appended, but any change to an
// existing assertion, contested supersession, or competing priority-1 action
// becomes an explicit unresolved conflict instead of silently overwriting.

const ASSERTION_TYPES = [
  'plan', 'completed_work', 'decisions', 'evidence', 'assumptions',
  'rejected_approaches', 'unknowns', 'blockers', 'risks', 'next_actions',
];
const INACTIVE_STATUSES = new Set(['superseded', 'resolved', 'rejected', 'completed', 'blocked']);

export function applyUpdate(current, update, inputs = {}) {
  const clock = inputs.clock ?? update.envelope.created_at;
  const policy = inputs.policy;

  if (!sameRepositoryIdentity(current.envelope, update.envelope)) {
    return {
      ok: false,
      errors: [{
        path: '$.repository',
        code: 'foreign-project',
        message: 'update repository identity does not match the current project',
      }],
    };
  }

  if (update.envelope.parent_snapshot_id === current.envelope.snapshot_id) {
    return { ok: true, state: update, conflicts: unresolvedConflicts(update) };
  }

  const merged = structuredClone(current.envelope);
  const currentById = indexById(current.envelope);
  const currentTrust = current.envelope.trust.level;
  const updateTrust = update.envelope.trust.level;
  const structural = [];
  const contestedReferences = new Set();
  const assertionTrust = new Map();

  for (const type of ASSERTION_TYPES) {
    for (const item of current.envelope[type]) assertionTrust.set(item.id, currentTrust);
  }

  for (const reference of update.envelope.references) {
    const existing = merged.references.find((candidate) => candidate.id === reference.id);
    if (!existing) {
      merged.references = [...merged.references, structuredClone(reference)];
      continue;
    }
    if (canonicalize(existing) !== canonicalize(reference)) {
      contestedReferences.add(reference.id);
      structural.push(conflict('reference-modified', 'references', [
        referenceCandidate(existing, currentTrust, current.envelope.created_at),
        referenceCandidate(reference, updateTrust, update.envelope.created_at),
      ]));
    }
  }

  for (const type of ASSERTION_TYPES) {
    for (const item of update.envelope[type]) {
      const existing = currentById.get(item.id);
      if (existing) {
        if (canonicalize(existing) !== canonicalize(item)) {
          structural.push(conflict('assertion-modified', type, [
            candidate(existing, currentTrust),
            candidate(item, updateTrust),
          ]));
        }
        continue;
      }
      const contested = item.supersedes.filter((id) => currentById.has(id));
      if (contested.length) {
        structural.push(conflict('supersession-contested', type, [candidate(item, updateTrust)]));
        continue;
      }
      if (item.provenance.some((id) => contestedReferences.has(id))) continue;
      merged[type] = [...merged[type], structuredClone(item)];
      assertionTrust.set(item.id, updateTrust);
    }
  }

  const priorityContenders = merged.next_actions.filter((item) => !INACTIVE_STATUSES.has(item.status) && item.priority === 1);
  if (priorityContenders.length > 1) {
    structural.push(conflict('priority-contention', 'next_actions', priorityContenders.map((item) => candidate(item, assertionTrust.get(item.id) ?? 'local-unverified'))));
  }

  merged.conflicts = [...merged.conflicts, ...structural];
  merged.parent_snapshot_id = current.envelope.snapshot_id;
  merged.created_at = clock;
  merged.trust = {
    level: 'local-unverified',
    reasons: ['synthesized locally from a conservative stale-update merge'],
  };
  merged.integrity.signature = { status: 'unsigned', algorithm: null, key_id: null, value: null };

  const encoded = encodeEnvelope({ envelope: merged });
  const rebuilt = createProjectState(encoded, { clock, policy });
  if (!rebuilt.ok) return rebuilt;
  return { ok: true, state: rebuilt.state, conflicts: unresolvedConflicts(rebuilt.state) };
}

function sameRepositoryIdentity(current, update) {
  return current.repository.project_id === update.repository.project_id
    && current.repository.root_identity === update.repository.root_identity;
}

function indexById(envelope) {
  const index = new Map();
  for (const type of ASSERTION_TYPES) for (const item of envelope[type]) index.set(item.id, item);
  return index;
}

function conflict(kind, domain, candidates) {
  return { kind, severity: 'high', status: 'unresolved', domain, candidates };
}

function candidate(item, trust) {
  return {
    assertion_id: item.id,
    value: item.text,
    provenance: item.provenance,
    repository_binding: item.repository_fingerprint ?? null,
    trust,
    created_at: item.created_at,
    expires_at: item.expires_at ?? null,
  };
}

function referenceCandidate(reference, trust, createdAt) {
  return {
    assertion_id: reference.id,
    value: `${reference.kind}:${reference.locator}`,
    provenance: [reference.id],
    repository_binding: null,
    trust,
    created_at: createdAt,
    expires_at: null,
  };
}
