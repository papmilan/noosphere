import { createProjectState } from './project-state.js';
import { canonicalize } from './wire.js';
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

  if (update.envelope.parent_snapshot_id === current.envelope.snapshot_id) {
    return { ok: true, state: update, conflicts: unresolvedConflicts(update) };
  }

  const merged = structuredClone(current.envelope);
  const currentById = indexById(current.envelope);
  const currentTrust = current.envelope.trust.level;
  const updateTrust = update.envelope.trust.level;
  const structural = [];

  for (const reference of update.envelope.references) {
    if (!merged.references.some((existing) => existing.id === reference.id)) {
      merged.references = [...merged.references, structuredClone(reference)];
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
      merged[type] = [...merged[type], structuredClone(item)];
    }
  }

  const priorityContenders = merged.next_actions.filter((item) => !INACTIVE_STATUSES.has(item.status) && item.priority === 1);
  if (priorityContenders.length > 1) {
    structural.push(conflict('priority-contention', 'next_actions', priorityContenders.map((item) => candidate(item, currentTrust))));
  }

  merged.conflicts = [...merged.conflicts, ...structural];
  const rebuilt = createProjectState(merged, { clock, policy });
  if (!rebuilt.ok) return rebuilt;
  return { ok: true, state: rebuilt.state, conflicts: unresolvedConflicts(rebuilt.state) };
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
