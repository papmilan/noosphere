import { ACP_LIMITS } from '@noosphere/acp-protocol';

export function reconcileExactState({
  local,
  remoteHeads = [],
  validatedById,
  compatibility,
  clock,
  policy = {},
  historyById,
  projectId,
  rootIdentity,
}) {
  const heads = [...new Set(remoteHeads)].sort();
  const graph = new Map(validatedById || []);
  if (local?.envelope?.snapshot_id) graph.set(local.envelope.snapshot_id, local);
  if (graph.size > ACP_LIMITS.ancestryEnvelopes) return incomplete();
  if (metadataDisagrees(graph, historyById)) return incomplete();

  const localEnvelope = local?.envelope || null;
  const localId = localEnvelope?.snapshot_id || null;
  if (heads.length === 0) {
    return localId ? { action: 'push-local', actionable: true } : { action: 'deferred', actionable: false, reason: 'remote-empty' };
  }
  const expectedProject = projectId ?? localEnvelope?.repository?.project_id;
  const expectedRoot = rootIdentity ?? localEnvelope?.repository?.root_identity;
  const candidates = heads.map((head) => graph.get(head)).filter(Boolean);
  if (candidates.length !== heads.length || heads.some((head) => !completePath(head, graph, localId))) return incomplete();
  const lineage = lineageStates(heads, graph, localId);
  if (lineage.some((candidate) => isForeign(candidate, expectedProject, expectedRoot))) {
    return quarantine('foreign-state', heads);
  }
  if (candidates.some((candidate) => isExpired(candidate, clock))) {
    return quarantine('remote-expired', heads);
  }
  if (localId && heads.includes(localId)) return { action: 'already-synced', actionable: false };

  if (localId && heads.length > 0 && heads.every((head) => isAncestor(head, localId, graph))) {
    return { action: 'push-local', actionable: true };
  }
  if (heads.length !== 1) return diverged(heads);

  const candidateId = heads[0];
  const isRemoteCandidate = localId == null || isAncestor(localId, candidateId, graph);
  if (!isRemoteCandidate) return diverged(heads);
  const status = compatibility?.status || 'unknown';
  const downgrade = compatibility?.trustDowngrade ?? compatibility?.trust_downgrade ?? 0;
  if (status === 'foreign') return quarantine('foreign-state', heads);
  if (status === 'diverged' || status === 'unknown') return { action: 'deferred', actionable: false, reason: `git-${status}` };
  if (status === 'advanced' && !policy.allowStaleAdvanced) {
    return { action: 'historical-advanced', candidate_snapshot_id: candidateId, actionable: false, trust_downgrade: downgrade };
  }
  if (!['exact', 'compatible', 'advanced'].includes(status)) {
    return { action: 'deferred', actionable: false, reason: 'git-unknown' };
  }
  return {
    action: localId == null ? 'remote-only-restore' : 'fast-forward-local',
    candidate_snapshot_id: candidateId,
    actionable: true,
    requires_confirmation: true,
    trust_downgrade: downgrade,
  };
}

function completePath(start, graph, localId) {
  const seen = new Set();
  let cursor = start;
  while (cursor) {
    if (seen.has(cursor) || seen.size >= ACP_LIMITS.ancestryEnvelopes) return false;
    seen.add(cursor);
    if (cursor === localId) return true;
    const state = graph.get(cursor);
    if (!state) return false;
    cursor = state.envelope.parent_snapshot_id;
  }
  return true;
}

function isAncestor(ancestor, descendant, graph) {
  const seen = new Set();
  let cursor = descendant;
  while (cursor && !seen.has(cursor) && seen.size < ACP_LIMITS.ancestryEnvelopes) {
    if (cursor === ancestor) return true;
    seen.add(cursor);
    cursor = graph.get(cursor)?.envelope?.parent_snapshot_id || null;
  }
  return false;
}

function lineageStates(heads, graph, localId) {
  const states = new Map();
  for (const head of heads) {
    let cursor = head;
    while (cursor) {
      const state = graph.get(cursor);
      if (!state) break;
      states.set(cursor, state);
      if (cursor === localId) break;
      cursor = state.envelope.parent_snapshot_id;
    }
  }
  return [...states.values()];
}

function metadataDisagrees(graph, historyById) {
  if (!historyById) return false;
  const entries = historyById instanceof Map
    ? historyById
    : Array.isArray(historyById)
      ? historyById.map((item) => [item.snapshot_id, item])
      : Object.entries(historyById);
  for (const [snapshotId, metadata] of entries) {
    const canonical = graph.get(snapshotId)?.envelope;
    if (canonical && metadata?.parent_snapshot_id !== undefined
      && metadata.parent_snapshot_id !== canonical.parent_snapshot_id) return true;
  }
  return false;
}

function isForeign(state, projectId, rootIdentity) {
  const repository = state.envelope.repository;
  return (projectId !== undefined && repository?.project_id !== projectId)
    || (rootIdentity !== undefined && repository?.root_identity !== rootIdentity);
}

function isExpired(state, clock) {
  const expiry = state.envelope.expires_at;
  return expiry != null && Date.parse(expiry) <= normalizeClock(clock);
}

function normalizeClock(clock) {
  if (typeof clock === 'function') return Number(clock());
  if (typeof clock === 'string') return Date.parse(clock);
  return Number(clock ?? Date.now());
}

function incomplete() { return { action: 'incomplete-lineage', actionable: false }; }
function quarantine(reason, heads) { return { action: 'quarantine', reason, actionable: false, remote_heads: heads }; }
function diverged(heads) { return { action: 'diverged', actionable: false, remote_heads: heads }; }
