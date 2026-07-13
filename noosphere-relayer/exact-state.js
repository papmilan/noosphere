import {
  ACP_LIMITS,
  RECONCILIATION_POLICY_VERSION,
  SYNC_PROTOCOL_VERSION,
  canonicalize,
  digestHeadSet,
} from '@noosphere/acp-protocol';
import { decodeProjectStateEnvelope } from './acp-protocol.js';
import { assertCanonicalId, exactError } from './snapshot-backend.js';

export class ExactStateService {
  constructor({ backend, index, limits = ACP_LIMITS, now = () => Date.now() }) {
    this.backend = backend;
    this.index = index;
    this.limits = limits;
    this.now = now;
  }

  async putSnapshot(projectId, envelope, expectedHeadsDigest, options = {}) {
    if (canonicalSize(envelope) > this.limits.snapshotBytes) {
      throw exactError('snapshot-too-large', 413);
    }
    const decoded = decodeProjectStateEnvelope(envelope);
    if (!decoded.ok) throw exactError(decoded.errors[0].code, 400, decoded.errors);
    if (decoded.envelope.repository?.project_id !== projectId) throw exactError('project-id-mismatch', 400);
    const bytes = Buffer.from(canonicalize(decoded.envelope), 'utf8');
    if (bytes.length > this.limits.snapshotBytes) throw exactError('snapshot-too-large', 413);
    const snapshotId = decoded.envelope.snapshot_id;
    assertCanonicalId(snapshotId);
    const clock = options.now || this.now;
    const before = normalizeRecord(await this.index.readExactProject(projectId));
    const existing = before.snapshots[snapshotId];
    if (existing) {
      if (before.heads_digest !== expectedHeadsDigest) {
        throw exactError('stale-heads', 409, headsView(before, clock()));
      }
      const storedBytes = await this.backend.get(projectId, snapshotId, existing.storage);
      if (!Buffer.from(storedBytes).equals(bytes)) throw exactError('snapshot-integrity-conflict');
      return {
        ...headsView(before, clock()), snapshot_id: snapshotId, created: false,
        storage: existing.storage, actionable: isActionable(existing, clock()),
      };
    }
    const receipt = await this.backend.put(projectId, snapshotId, bytes);
    const storedAt = new Date(clock()).toISOString();
    let created = false;
    const record = await this.index.updateExactProject(projectId, (current) => {
      current = normalizeRecord(current);
      if (current.heads_digest !== expectedHeadsDigest) {
        throw exactError('stale-heads', 409, headsView(current, clock()));
      }
      const existing = current.snapshots[snapshotId];
      if (!existing) {
        if (Object.keys(current.snapshots).length >= this.limits.indexedSnapshotsPerProject) {
          throw exactError('snapshot-index-limit', 507);
        }
        if (current.indexed_bytes + bytes.length > this.limits.indexedBytesPerProject) {
          throw exactError('project-byte-limit', 507);
        }
        current.snapshots[snapshotId] = {
          snapshot_id: snapshotId,
          parent_snapshot_id: decoded.envelope.parent_snapshot_id ?? null,
          created_at: decoded.envelope.created_at,
          expires_at: decoded.envelope.expires_at ?? null,
          stored_at: storedAt,
          bytes: bytes.length,
          storage: receipt,
        };
        created = true;
      }
      const next = recomputeProject(current);
      if (next.heads.length > this.limits.concurrentHeadsPerProject) {
        throw exactError('head-limit', 409);
      }
      return next;
    });
    const item = record.snapshots[snapshotId];
    return { ...headsView(record, clock()), snapshot_id: snapshotId, created, storage: item.storage, actionable: isActionable(item, clock()) };
  }

  async getSnapshot(projectId, snapshotId) {
    assertCanonicalId(snapshotId);
    const record = normalizeRecord(await this.index.readExactProject(projectId));
    if (!record.snapshots[snapshotId]) throw exactError('snapshot-not-found', 404);
    const bytes = await this.backend.get(projectId, snapshotId, record.snapshots[snapshotId].storage);
    const text = bytes.toString('utf8');
    const decoded = decodeProjectStateEnvelope(text);
    if (!decoded.ok || decoded.envelope.snapshot_id !== snapshotId || canonicalize(decoded.envelope) !== text) {
      throw exactError('snapshot-integrity-conflict');
    }
    return { snapshot_id: snapshotId, bytes };
  }

  async getHeads(projectId) {
    return headsView(normalizeRecord(await this.index.readExactProject(projectId)), this.now());
  }

  async getHistory(projectId, { head, limit = this.limits.ancestryEnvelopes } = {}) {
    if (head !== undefined) assertCanonicalId(head);
    const record = normalizeRecord(await this.index.readExactProject(projectId));
    const capped = Math.max(0, Math.min(limit, this.limits.ancestryEnvelopes));
    const result = [];
    const seen = new Set();
    let cursor = head || record.heads[0] || null;
    while (cursor && result.length < capped && !seen.has(cursor)) {
      seen.add(cursor);
      const item = record.snapshots[cursor];
      if (!item) break;
      result.push({
        ...structuredClone(item),
        parent_indexed: item.parent_snapshot_id == null || Boolean(record.snapshots[item.parent_snapshot_id]),
        actionable: isActionable(item, this.now()),
      });
      cursor = item.parent_snapshot_id;
    }
    return result;
  }

  async getCapabilities() {
    const [backendHealth, indexHealth, relayerIndexId] = await Promise.all([
      this.backend.health(), this.index.health(), this.index.exactStateIdentity(),
    ]);
    const shared = Boolean(backendHealth.shared) && Boolean(indexHealth.shared);
    return {
      deployment_mode: backendHealth.deployment_mode || (shared ? 'shared-relayer' : 'local-only'),
      exact_bytes_durable: Boolean(backendHealth.durable),
      index_durable: Boolean(indexHealth.durable),
      cross_machine_recoverable: shared && Boolean(backendHealth.durable) && Boolean(indexHealth.durable),
      relayer_index_id: relayerIndexId,
      sync_protocol_version: SYNC_PROTOCOL_VERSION,
      reconciliation_policy_version: RECONCILIATION_POLICY_VERSION,
    };
  }
}

function canonicalSize(value) {
  try { return Buffer.byteLength(canonicalize(value), 'utf8'); }
  catch { return 0; }
}

export function recomputeProject(record) {
  const ids = Object.keys(record.snapshots);
  const parentIds = new Set(ids.map((id) => record.snapshots[id].parent_snapshot_id).filter(Boolean));
  const heads = ids.filter((id) => !parentIds.has(id)).sort();
  return {
    ...record,
    heads,
    heads_digest: digestHeadSet(heads),
    complete: ids.every((id) => {
      const parent = record.snapshots[id].parent_snapshot_id;
      return parent == null || Boolean(record.snapshots[parent]);
    }),
    indexed_bytes: ids.reduce((total, id) => total + record.snapshots[id].bytes, 0),
  };
}

function normalizeRecord(record) {
  return recomputeProject({ snapshots: {}, indexed_bytes: 0, ...record });
}

function headsView(record, now) {
  return {
    heads: [...record.heads],
    head_records: record.heads.map((snapshotId) => {
      const item = record.snapshots[snapshotId];
      return { snapshot_id: snapshotId, expires_at: item.expires_at, actionable: isActionable(item, now) };
    }),
    heads_digest: record.heads_digest,
    complete: record.complete,
  };
}

function isActionable(item, now) {
  return !item.expires_at || Date.parse(item.expires_at) > now;
}
