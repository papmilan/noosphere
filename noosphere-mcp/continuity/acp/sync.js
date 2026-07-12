import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  ACP_LIMITS, RECONCILIATION_POLICY_VERSION, SYNC_PROTOCOL_VERSION,
  canonicalize, digestHeadSet,
} from '@noosphere/acp-protocol';
import { classifyCompatibility, observeRepository } from './git-state.js';
import { reconcileExactState } from './reconcile.js';
import { readState, writeStateIfCurrent } from './store.js';
import {
  consumeConfirmation, digestRepositoryObservation, issueConfirmation, quarantineBytes,
} from './sync-metadata.js';
import { projectAdvancedTrust } from './trust-projection.js';
import { decodeEnvelope } from './wire.js';

export async function discoverRemoteState(root, projectId, deps, options = {}) {
  const client = deps.client;
  const clock = deps.clock ?? Date.now;
  const capabilities = await client.capabilities();
  assertCapabilities(capabilities);
  const headsResult = await client.getHeads(projectId);
  const remoteHeads = normalizeHeads(headsResult);
  if (headsResult.heads_digest !== digestHeadSet(remoteHeads)) throw syncError('remote-head-digest');
  const localResult = await (deps.readState ?? readState)(root, { clock: clockIso(clock) });
  if (localResult && !localResult.ok) throw syncError('local-state-invalid');
  const local = localResult?.state ?? null;

  const history = [];
  for (const head of remoteHeads) {
    const response = await client.getHistory(projectId, { head, limit: ACP_LIMITS.ancestryEnvelopes });
    history.push(...(response.history || []));
  }
  const historyById = new Map();
  for (const item of history) {
    const existing = historyById.get(item.snapshot_id);
    if (existing && existing.parent_snapshot_id !== item.parent_snapshot_id) {
      return incompleteDiscovery({ capabilities, headsResult, remoteHeads, local });
    }
    historyById.set(item.snapshot_id, item);
  }
  const ids = [...new Set([...remoteHeads, ...historyById.keys()])].sort();
  if (ids.length > ACP_LIMITS.ancestryEnvelopes) return incompleteDiscovery({ capabilities, headsResult, remoteHeads, local });
  const validatedById = new Map();
  const canonicalById = new Map();
  for (const snapshotId of ids) {
    const response = await client.getSnapshot(projectId, snapshotId);
    const bytes = Buffer.from(response.bytes);
    try {
      if (bytes.length > ACP_LIMITS.snapshotBytes) throw syncError('snapshot-too-large');
      const text = bytes.toString('utf8');
      const decoded = decodeEnvelope(text, { clock: clockIso(clock) });
      if (!decoded.ok) throw syncError('remote-invalid', decoded.errors);
      if (decoded.state.envelope.snapshot_id !== snapshotId || canonicalize(decoded.state.envelope) !== text) {
        throw syncError('remote-invalid');
      }
      validatedById.set(snapshotId, decoded.state);
      canonicalById.set(snapshotId, text);
    } catch (error) {
      await (deps.quarantineBytes ?? quarantineBytes)(root, snapshotId, bytes).catch(() => undefined);
      throw error;
    }
  }
  if (local) validatedById.set(local.envelope.snapshot_id, local);
  const observed = await (deps.observeRepository ?? observeRepository)(root);
  const candidate = remoteHeads.length === 1 ? validatedById.get(remoteHeads[0]) : null;
  const compatibility = candidate
    ? (deps.classifyCompatibility ?? classifyCompatibility)(candidate, observed)
    : { status: 'unknown', trustDowngrade: 3, actionable: false, reasons: [] };
  const reconciliation = reconcileExactState({
    local, remoteHeads, validatedById, compatibility, historyById,
    clock: clockValue(clock), policy: { allowStaleAdvanced: options.allowStaleAdvanced === true },
    projectId, rootIdentity: observed.root_identity,
  });
  if (reconciliation.action === 'quarantine') {
    for (const head of remoteHeads) {
      const canonical = canonicalById.get(head);
      if (canonical) await (deps.quarantineBytes ?? quarantineBytes)(root, head, Buffer.from(canonical)).catch(() => undefined);
    }
  }
  const remoteState = reconciliation.candidate_snapshot_id
    ? validatedById.get(reconciliation.candidate_snapshot_id) : candidate;
  return {
    capabilities, headsResult, remoteHeads, validatedById, canonicalById, local,
    observed, compatibility, reconciliation, remoteState,
    canonical_remote: remoteState ? canonicalById.get(remoteState.envelope.snapshot_id) : null,
  };
}

export async function pushLocalState(root, projectId, deps) {
  const capabilities = await deps.client.capabilities();
  assertCapabilities(capabilities);
  const heads = await deps.client.getHeads(projectId);
  const localResult = await (deps.readState ?? readState)(root, { clock: clockIso(deps.clock ?? Date.now) });
  if (!localResult?.ok) throw syncError('local-state-missing');
  return deps.client.putSnapshot(projectId, localResult.state.envelope, heads.heads_digest);
}

export async function issueRemoteConfirmation(root, projectId, deps, options = {}) {
  const discovery = await discoverRemoteState(root, projectId, deps, options);
  return issueFromDiscovery(root, discovery, deps, options);
}

async function issueFromDiscovery(root, discovery, deps, options) {
  if (!discovery.reconciliation.actionable || !discovery.reconciliation.candidate_snapshot_id) {
    return { ...discovery, confirmation: null };
  }
  const confirmation = await (deps.issueConfirmation ?? issueConfirmation)(root, {
    remote_snapshot_id: discovery.reconciliation.candidate_snapshot_id,
    local_snapshot_id: discovery.local?.envelope.snapshot_id ?? null,
    remote_heads_digest: discovery.headsResult.heads_digest,
    repository_observation: discovery.observed,
    relayer_index_id: discovery.capabilities.relayer_index_id,
    sync_protocol_version: discovery.capabilities.sync_protocol_version,
    reconciliation_policy_version: discovery.capabilities.reconciliation_policy_version,
    action: discovery.reconciliation.action,
    allow_stale_advanced: options.allowStaleAdvanced === true,
    remote_expires_at: discovery.remoteState.envelope.expires_at ?? null,
  }, deps.clock ?? Date.now);
  return { ...discovery, confirmation };
}

export async function applyRemoteConfirmation(root, confirmationId, deps) {
  let confirmation;
  let final;
  let trustProjection;
  try {
    confirmation = await (deps.consumeConfirmation ?? consumeConfirmation)(root, confirmationId, deps.clock ?? Date.now);
  } catch (error) {
    if (error.code === 'confirmation-missing') throw error;
    throw syncError('confirmation-stale', error);
  }
  try {
    const observe = deps.observeAndReconcile
      ?? ((target, bound) => observeAndReconcile(target, bound, deps));
    const first = await observe(root, confirmation);
    assertMatchesConfirmation(first, confirmation);
    await deps.afterFirstObservation?.(first);
    final = await observe(root, confirmation);
    assertMatchesConfirmation(final, confirmation);
    if (barrierDigest(first) !== barrierDigest(final)) throw syncError('confirmation-stale');
    trustProjection = confirmation.allow_stale_advanced && final.compatibility?.status === 'advanced'
      ? projectAdvancedTrust(final.remoteState) : undefined;
  } catch (error) {
    if (error.code === 'confirmation-stale') throw error;
    throw syncError('confirmation-stale', error);
  }
  return (deps.writeStateIfCurrent ?? writeStateIfCurrent)(
    root, final.remoteState, confirmation.local_snapshot_id,
    { compatibility: final.compatibility, trustProjection, clock: clockIso(deps.clock ?? Date.now) },
  );
}

export async function syncProjectState(root, projectId, deps, options = {}) {
  const discovery = await discoverRemoteState(root, projectId, deps, options);
  if (discovery.reconciliation.action === 'push-local') {
    return { ...discovery, push: await pushLocalState(root, projectId, deps) };
  }
  if (discovery.reconciliation.actionable && discovery.reconciliation.candidate_snapshot_id) {
    return issueFromDiscovery(root, discovery, deps, options);
  }
  return discovery;
}

export async function listRemoteHistory(projectId, options, deps) {
  const capabilities = await deps.client.capabilities();
  assertCapabilities(capabilities);
  return deps.client.getHistory(projectId, options);
}

export async function listQuarantine(root) {
  const directory = path.join(root, '.noosphere', 'quarantine');
  const names = await readdir(directory).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const entries = [];
  for (const name of names.filter((value) => /^sha256-[0-9a-f]{64}\.json$/.test(value)).sort()) {
    const details = await lstat(path.join(directory, name));
    if (!details.isFile() || details.isSymbolicLink()) continue;
    entries.push({ name, bytes: details.size, modified_at: details.mtime.toISOString() });
  }
  return entries;
}

async function observeAndReconcile(root, confirmation, deps) {
  const discovery = await discoverRemoteState(root, deps.projectId, deps, {
    allowStaleAdvanced: confirmation.allow_stale_advanced,
  });
  return {
    remote_snapshot_id: discovery.reconciliation.candidate_snapshot_id,
    local_snapshot_id: discovery.local?.envelope.snapshot_id ?? null,
    remote_heads_digest: discovery.headsResult.heads_digest,
    repository_observation_digest: digestRepositoryObservation(discovery.observed),
    relayer_index_id: discovery.capabilities.relayer_index_id,
    sync_protocol_version: discovery.capabilities.sync_protocol_version,
    reconciliation_policy_version: discovery.capabilities.reconciliation_policy_version,
    action: discovery.reconciliation.action,
    allow_stale_advanced: confirmation.allow_stale_advanced,
    canonical_remote: discovery.canonical_remote,
    remoteState: discovery.remoteState,
    compatibility: discovery.compatibility,
  };
}

function assertMatchesConfirmation(observation, confirmation) {
  for (const key of [
    'remote_snapshot_id', 'local_snapshot_id', 'remote_heads_digest', 'repository_observation_digest',
    'relayer_index_id', 'sync_protocol_version', 'reconciliation_policy_version', 'action', 'allow_stale_advanced',
  ]) if (observation[key] !== confirmation[key]) throw syncError('confirmation-stale');
}

function barrierDigest(value) {
  return canonicalize({
    remote_snapshot_id: value.remote_snapshot_id,
    local_snapshot_id: value.local_snapshot_id,
    remote_heads_digest: value.remote_heads_digest,
    repository_observation_digest: value.repository_observation_digest,
    relayer_index_id: value.relayer_index_id,
    sync_protocol_version: value.sync_protocol_version,
    reconciliation_policy_version: value.reconciliation_policy_version,
    action: value.action,
    allow_stale_advanced: value.allow_stale_advanced,
    canonical_remote: value.canonical_remote,
  });
}

function normalizeHeads(result) {
  if (!Array.isArray(result.heads) || result.heads.length > ACP_LIMITS.concurrentHeadsPerProject) throw syncError('remote-heads-invalid');
  return [...new Set(result.heads)].sort();
}
function assertCapabilities(value) {
  if (!value?.exact_bytes_durable || !value?.index_durable
    || value.sync_protocol_version !== SYNC_PROTOCOL_VERSION
    || value.reconciliation_policy_version !== RECONCILIATION_POLICY_VERSION
    || !/^sha256:[0-9a-f]{64}$/.test(value.relayer_index_id)) throw syncError('unsupported-capabilities');
}
function incompleteDiscovery(base) { return { ...base, reconciliation: { action: 'incomplete-lineage', actionable: false }, validatedById: new Map(), canonicalById: new Map(), remoteState: null }; }
function clockValue(clock) { return typeof clock === 'function' ? clock() : clock; }
function clockIso(clock) { const value = clockValue(clock); return typeof value === 'string' ? value : new Date(value).toISOString(); }
function syncError(code, cause) { return Object.assign(new Error(code, { cause }), { code }); }
