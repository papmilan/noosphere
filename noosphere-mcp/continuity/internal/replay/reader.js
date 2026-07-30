import fs from 'node:fs/promises';

import { createFormatV2Store } from '../trust-format-v2.js';
import {
  RETENTION_POLICY,
  listRetentionJournals,
  readRetentionCheckpoint,
  retentionCheckpointDigest,
} from './retention.js';
import { listReplayJournals } from './journal.js';
import { loadReplayKey } from './key.js';
import {
  listReplayRecords,
  readReplayManifest,
  replayRecordIndexDigest,
  replayProjectPaths,
} from './store.js';

async function existingDirectory(directory) {
  const stat = await fs.lstat(directory).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  return Boolean(stat?.isDirectory() && !stat.isSymbolicLink());
}

async function readContext({ env, projectRoot }) {
  const authority = createFormatV2Store({ env });
  let projectIdentityDigest;
  try {
    projectIdentityDigest =
      await authority.canonicalProjectIdentityDigest(projectRoot);
  } catch (error) {
    return Object.freeze({
      unavailable: true,
      reason: error.code ?? 'project-identity-unavailable',
      projectIdentityDigest: null,
    });
  }
  let key;
  try {
    key = await loadReplayKey({ env });
  } catch (error) {
    return Object.freeze({
      unavailable: true,
      reason: error.code ?? 'replay-key-unavailable',
      projectIdentityDigest,
    });
  }
  if (key === null) {
    return Object.freeze({
      unavailable: true,
      reason: 'replay-uninitialized',
      projectIdentityDigest,
    });
  }
  const paths = replayProjectPaths({ env, projectIdentityDigest });
  if (
    !await existingDirectory(paths.project) ||
    !await existingDirectory(paths.records) ||
    !await existingDirectory(paths.journals) ||
    !await existingDirectory(paths.retention)
  ) {
    return Object.freeze({
      unavailable: true,
      reason: 'replay-project-unavailable',
      projectIdentityDigest,
    });
  }
  const retentionJournalsRoot = `${paths.retention}/journals`;
  if (!await existingDirectory(retentionJournalsRoot)) {
    return Object.freeze({
      unavailable: true,
      reason: 'replay-retention-journals-unavailable',
      projectIdentityDigest,
    });
  }
  const [manifest, records, journals, retentionJournals, checkpoint] =
    await Promise.all([
      readReplayManifest({ env, key, projectIdentityDigest }),
      listReplayRecords({ env, key, projectIdentityDigest }),
      listReplayJournals({ env, key, projectIdentityDigest }),
      listRetentionJournals({ env, key, projectIdentityDigest }),
      readRetentionCheckpoint({ env, key, projectIdentityDigest }),
    ]);
  if (
    manifest.recordCount !== records.length ||
    manifest.recordIndexDigest !== replayRecordIndexDigest(records) ||
    (manifest.retentionGeneration === 0
      ? checkpoint !== null || manifest.retentionCheckpointDigest !== null
      : checkpoint === null ||
        checkpoint.retentionGeneration !== manifest.retentionGeneration ||
        retentionCheckpointDigest(checkpoint) !==
          manifest.retentionCheckpointDigest)
  ) {
    throw new Error('authenticated replay indexes are inconsistent');
  }
  return Object.freeze({
    unavailable: false,
    env,
    key,
    projectIdentityDigest,
    manifest,
    records,
    journals,
    retentionJournals,
    checkpoint,
  });
}

function unavailableStatus(context) {
  return Object.freeze({
    health: 'UNAVAILABLE',
    reason: context.reason,
    projectIdentityDigest: context.projectIdentityDigest,
    recordCount: 0,
    maximumLiveRecords: RETENTION_POLICY.maximumLiveRecords,
    maximumRecordAgeDays: RETENTION_POLICY.maximumRecordAgeDays,
    oldestObservation: null,
    newestObservation: null,
    retentionGeneration: 0,
    totalEvictedRecords: 0,
    incompleteJournalCount: 0,
  });
}

export async function readReplayStatus({
  env = process.env,
  projectRoot,
}) {
  const context = await readContext({ env, projectRoot });
  if (context.unavailable) return unavailableStatus(context);
  const incompleteJournalCount = [
    ...context.journals,
    ...context.retentionJournals,
  ].filter(journal => !journal.complete).length;
  const observations = context.records
    .map(record => record.lastSeen.observedAt)
    .sort();
  return Object.freeze({
    health: incompleteJournalCount > 0
      ? 'RECOVERY_REQUIRED'
      : 'HEALTHY',
    reason: null,
    projectIdentityDigest: context.projectIdentityDigest,
    recordCount: context.manifest.recordCount,
    maximumLiveRecords: RETENTION_POLICY.maximumLiveRecords,
    maximumRecordAgeDays: RETENTION_POLICY.maximumRecordAgeDays,
    oldestObservation: observations[0] ?? null,
    newestObservation: observations.at(-1) ?? null,
    retentionGeneration: context.manifest.retentionGeneration,
    totalEvictedRecords: context.checkpoint?.totalEvictedRecords ?? 0,
    incompleteJournalCount,
  });
}

function publicProjection(record) {
  return Object.freeze({
    replayIdentity: record.replayIdentity,
    projectIdentityDigest: record.projectIdentityDigest,
    slot: record.slot,
    firstSeen: record.firstSeen,
    lastSeen: record.lastSeen,
    replayCount: record.replayCount,
    state: record.state,
    lastClassification: record.lastClassification,
  });
}

export async function listReplayEvidence({
  env = process.env,
  projectRoot,
  slot,
  limit = 100,
}) {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    throw new TypeError('replay list limit is invalid');
  }
  const context = await readContext({ env, projectRoot });
  if (context.unavailable) return Object.freeze([]);
  const records = context.records
    .filter(record => slot === undefined || record.slot === slot)
    .sort((left, right) =>
      right.lastSeen.observedAt.localeCompare(left.lastSeen.observedAt) ||
      left.replayIdentity.localeCompare(right.replayIdentity))
    .slice(0, limit)
    .map(publicProjection);
  return Object.freeze(records);
}
