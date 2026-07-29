import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  atomicOwnerOnlyWrite,
  ensureRealDirectoryPath,
  readBoundedRegularFile,
  writeOwnerOnlyFileExclusive,
} from '../../secure-fs.js';
import {
  TrustStoreError,
  canonicalize,
  homeDir,
} from '../../trust-store-internal.js';
import {
  AUTH_DOMAINS,
  sealRecord,
  verifyRecord,
} from '../authenticated-records.js';
import { REPLAY_METADATA_BYTES } from './constants.js';
import { replayKeyId } from './key.js';
import { assertReplayMutationScope } from './lock-ranks.js';
import {
  listReplayRecords,
  readReplayManifest,
  readReplayRecord,
  replayArtifactDigest,
  replayProjectPaths,
  writeReplayManifest,
} from './store.js';
import { listReplayJournals } from './journal.js';
import {
  parseReplayManifest,
  parseReplayRecord,
} from './schema.js';

export const RETENTION_POLICY = Object.freeze({
  maximumLiveRecords: 4096,
  maximumRecordAgeDays: 90,
  completedJournalDays: 7,
  maximumCompletedJournals: 1024,
  existingIdentityIntervalMs: 60 * 60 * 1000,
});

const DAY_MS = 24 * 60 * 60 * 1000;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const INITIAL_RETENTION_ACCUMULATOR =
  `sha256:${createHash('sha256').update(canonicalize([
    'noosphere.replay-retention.v1',
    null,
  ])).digest('hex')}`;
const CHECKPOINT_FIELDS = new Set([
  'domain',
  'schema',
  'version',
  'projectIdentityDigest',
  'retentionGeneration',
  'totalEvictedRecords',
  'mostRecentRetentionAt',
  'maxAgePolicy',
  'recordCountPolicy',
  'accumulator',
  'keyId',
  'mac',
]);

function retentionError(code, message) {
  return new TrustStoreError(code, message);
}

function timestamp(value, label) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical UTC timestamp`);
  }
  return parsed;
}

function recordOrder(left, right) {
  const time =
    timestamp(left.lastSeen.observedAt, 'record timestamp') -
    timestamp(right.lastSeen.observedAt, 'record timestamp');
  return time || left.replayIdentity.localeCompare(right.replayIdentity);
}

export function selectReplayRecordEvictions(records, {
  now,
  insertingNewIdentity,
}) {
  if (!Array.isArray(records) || typeof insertingNewIdentity !== 'boolean') {
    throw new TypeError('retention selection input is invalid');
  }
  const nowMs = timestamp(now, 'retention time');
  const ageCutoff =
    nowMs - RETENTION_POLICY.maximumRecordAgeDays * DAY_MS;
  const ordered = [...records].sort(recordOrder);
  const evictions = [];
  const retained = [];
  for (const record of ordered) {
    if (timestamp(record.lastSeen.observedAt, 'record timestamp') < ageCutoff) {
      evictions.push(Object.freeze({ record, reason: 'age' }));
    } else {
      retained.push(record);
    }
  }
  const target = insertingNewIdentity
    ? RETENTION_POLICY.maximumLiveRecords - 1
    : RETENTION_POLICY.maximumLiveRecords;
  const countEvictions = Math.max(0, retained.length - target);
  for (const record of retained.slice(0, countEvictions)) {
    evictions.push(Object.freeze({ record, reason: 'count' }));
  }
  return Object.freeze(evictions);
}

export function nextRetentionAccumulator(prior, record, reason) {
  if (
    typeof prior !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(prior) ||
    !['age', 'count'].includes(reason)
  ) {
    throw new TypeError('retention accumulator input is invalid');
  }
  return `sha256:${createHash('sha256').update(canonicalize([
    'noosphere.replay-retention.v1',
    prior,
    record.replayIdentity,
    record.recordGeneration,
    record.replayCount,
    record.state,
    record.lastSeen.observedAt,
    reason,
  ])).digest('hex')}`;
}

export function selectCompletedJournalEvictions(journals, { now }) {
  if (!Array.isArray(journals)) {
    throw new TypeError('journal retention input is invalid');
  }
  const cutoff =
    timestamp(now, 'retention time') -
    RETENTION_POLICY.completedJournalDays * DAY_MS;
  const completed = journals
    .filter(journal => journal.complete)
    .sort((left, right) => {
      const time =
        timestamp(left.latest.transitionAt, 'journal completion time') -
        timestamp(right.latest.transitionAt, 'journal completion time');
      return time || left.operationId.localeCompare(right.operationId);
    });
  const evicted = [];
  const retained = [];
  for (const journal of completed) {
    if (timestamp(journal.latest.transitionAt, 'journal completion time') < cutoff) {
      evicted.push(journal.operationId);
    } else {
      retained.push(journal);
    }
  }
  const overflow = Math.max(
    0,
    retained.length - RETENTION_POLICY.maximumCompletedJournals,
  );
  evicted.push(...retained.slice(0, overflow).map(item => item.operationId));
  return Object.freeze(evicted);
}

export function retentionCheckpointDigest(checkpoint) {
  return replayArtifactDigest(checkpoint);
}

function parseCheckpoint(raw, {
  key,
  projectIdentityDigest,
}) {
  let checkpoint;
  try {
    const text = raw.toString('utf8');
    checkpoint = JSON.parse(text);
    if (text !== canonicalize(checkpoint)) throw new Error('noncanonical');
  } catch {
    throw retentionError(
      'replay-retention-checkpoint-corrupt',
      'retention checkpoint is malformed',
    );
  }
  if (
    !checkpoint ||
    typeof checkpoint !== 'object' ||
    Array.isArray(checkpoint) ||
    Object.keys(checkpoint).length !== CHECKPOINT_FIELDS.size ||
    !Object.keys(checkpoint).every(field => CHECKPOINT_FIELDS.has(field)) ||
    checkpoint.domain !== AUTH_DOMAINS.replayCheckpoint ||
    checkpoint.schema !== 'noosphere.replay-retention' ||
    checkpoint.version !== 1 ||
    checkpoint.projectIdentityDigest !== projectIdentityDigest ||
    !Number.isSafeInteger(checkpoint.retentionGeneration) ||
    checkpoint.retentionGeneration < 1 ||
    !Number.isSafeInteger(checkpoint.totalEvictedRecords) ||
    checkpoint.totalEvictedRecords < 1 ||
    !canonicalTimestamp(checkpoint.mostRecentRetentionAt) ||
    checkpoint.maxAgePolicy !== 'last-seen-90-days-v1' ||
    checkpoint.recordCountPolicy !== 'maximum-4096-v1' ||
    !/^sha256:[0-9a-f]{64}$/.test(checkpoint.accumulator) ||
    checkpoint.keyId !== replayKeyId(key) ||
    !verifyRecord(key, AUTH_DOMAINS.replayCheckpoint, checkpoint)
  ) {
    throw retentionError(
      'replay-retention-checkpoint-invalid',
      'retention checkpoint authentication or binding failed',
    );
  }
  return checkpoint;
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

export async function readRetentionCheckpoint({
  env = process.env,
  key,
  projectIdentityDigest,
}) {
  const file = path.join(
    replayProjectPaths({ env, projectIdentityDigest }).retention,
    'checkpoint.json',
  );
  const raw = await readBoundedRegularFile(file, {
    maxBytes: REPLAY_METADATA_BYTES,
  });
  if (raw === null) return null;
  return parseCheckpoint(raw, { key, projectIdentityDigest });
}

async function writeCheckpoint({
  env,
  projectIdentityDigest,
  checkpoint,
}) {
  const file = path.join(
    replayProjectPaths({ env, projectIdentityDigest }).retention,
    'checkpoint.json',
  );
  await atomicOwnerOnlyWrite(file, canonicalize(checkpoint), {
    root: homeDir(env),
    maxBytes: REPLAY_METADATA_BYTES,
  });
}

function recordIndexDigest(records) {
  const entries = [...records]
    .sort((left, right) =>
      left.replayIdentity.localeCompare(right.replayIdentity))
    .map(record => [
      record.replayIdentity,
      record.recordGeneration,
      record.mac,
    ]);
  return `sha256:${createHash('sha256')
    .update(Buffer.from(canonicalize(entries), 'utf8'))
    .digest('hex')}`;
}

const RETENTION_JOURNAL_STATES = Object.freeze([
  'prepared',
  'checkpoint-committed',
  'manifest-committed',
  'record-removed',
  'complete',
]);
const RETENTION_JOURNAL_FILES = Object.freeze([
  '00-prepared.json',
  '01-checkpoint-committed.json',
  '02-manifest-committed.json',
  '03-record-removed.json',
  '04-complete.json',
]);
const RETENTION_JOURNAL_FIELDS = new Set([
  'domain',
  'schema',
  'version',
  'operationId',
  'state',
  'sequence',
  'previousMac',
  'projectIdentityDigest',
  'replayIdentity',
  'priorRecordDigest',
  'priorCheckpointDigest',
  'priorManifestDigest',
  'nextCheckpointDigest',
  'nextManifestDigest',
  'evictionReason',
  'retentionAt',
  'keyId',
  'record',
  'nextCheckpoint',
  'nextManifest',
  'mac',
]);

function retentionJournalsPath(env, projectIdentityDigest) {
  return path.join(
    replayProjectPaths({ env, projectIdentityDigest }).retention,
    'journals',
  );
}

function retentionJournalBase(entry) {
  const {
    state: ignoredState,
    sequence: ignoredSequence,
    previousMac: ignoredPreviousMac,
    mac: ignoredMac,
    ...base
  } = entry;
  return base;
}

async function appendRetentionTransition({
  env,
  key,
  base,
  state,
  sequence,
  previousMac,
}) {
  const directory = path.join(
    retentionJournalsPath(env, base.projectIdentityDigest),
    base.operationId,
  );
  await ensureRealDirectoryPath(directory);
  const entry = sealRecord(key, AUTH_DOMAINS.replayJournal, {
    ...base,
    domain: AUTH_DOMAINS.replayJournal,
    schema: 'noosphere.replay-retention-journal',
    version: 1,
    state,
    sequence,
    previousMac,
  });
  await writeOwnerOnlyFileExclusive(
    path.join(directory, RETENTION_JOURNAL_FILES[sequence]),
    canonicalize(entry),
    {
      root: homeDir(env),
      maxBytes: REPLAY_METADATA_BYTES,
    },
  );
  return entry;
}

function parseRetentionJournalEntry(raw, {
  key,
  operationId,
  projectIdentityDigest,
  sequence,
  previous,
}) {
  let entry;
  try {
    const text = raw.toString('utf8');
    entry = JSON.parse(text);
    if (text !== canonicalize(entry)) throw new Error('noncanonical');
  } catch {
    throw retentionError(
      'replay-retention-journal-corrupt',
      'retention journal is malformed',
    );
  }
  if (
    !entry ||
    typeof entry !== 'object' ||
    Array.isArray(entry) ||
    Object.keys(entry).length !== RETENTION_JOURNAL_FIELDS.size ||
    !Object.keys(entry).every(field => RETENTION_JOURNAL_FIELDS.has(field)) ||
    entry.domain !== AUTH_DOMAINS.replayJournal ||
    entry.schema !== 'noosphere.replay-retention-journal' ||
    entry.version !== 1 ||
    entry.operationId !== operationId ||
    entry.projectIdentityDigest !== projectIdentityDigest ||
    entry.sequence !== sequence ||
    entry.state !== RETENTION_JOURNAL_STATES[sequence] ||
    entry.previousMac !== (previous?.mac ?? null) ||
    !UUID_V4.test(entry.operationId) ||
    !/^sha256:[0-9a-f]{64}$/.test(entry.replayIdentity) ||
    !/^sha256:[0-9a-f]{64}$/.test(entry.priorRecordDigest) ||
    !/^sha256:[0-9a-f]{64}$/.test(entry.priorCheckpointDigest) ||
    !/^sha256:[0-9a-f]{64}$/.test(entry.priorManifestDigest) ||
    !/^sha256:[0-9a-f]{64}$/.test(entry.nextCheckpointDigest) ||
    !/^sha256:[0-9a-f]{64}$/.test(entry.nextManifestDigest) ||
    !['age', 'count'].includes(entry.evictionReason) ||
    !canonicalTimestamp(entry.retentionAt) ||
    entry.keyId !== replayKeyId(key) ||
    !verifyRecord(key, AUTH_DOMAINS.replayJournal, entry) ||
    replayArtifactDigest(entry.record) !== entry.priorRecordDigest ||
    retentionCheckpointDigest(entry.nextCheckpoint) !==
      entry.nextCheckpointDigest ||
    replayArtifactDigest(entry.nextManifest) !== entry.nextManifestDigest ||
    entry.record.replayIdentity !== entry.replayIdentity
  ) {
    throw retentionError(
      'replay-retention-journal-invalid',
      'retention journal authentication or binding failed',
    );
  }
  parseCheckpoint(Buffer.from(canonicalize(entry.nextCheckpoint)), {
    key,
    projectIdentityDigest,
  });
  parseReplayRecord(Buffer.from(canonicalize(entry.record)), {
    key,
    expectedProjectIdentityDigest: projectIdentityDigest,
    expectedReplayIdentity: entry.replayIdentity,
    expectedKeyId: replayKeyId(key),
  });
  parseReplayManifest(Buffer.from(canonicalize(entry.nextManifest)), {
    key,
    expectedProjectIdentityDigest: projectIdentityDigest,
    expectedKeyId: replayKeyId(key),
  });
  if (
    previous &&
    canonicalize(retentionJournalBase(previous)) !==
      canonicalize(retentionJournalBase(entry))
  ) {
    throw retentionError(
      'replay-retention-journal-spliced',
      'retention journal transition was spliced',
    );
  }
  return entry;
}

export async function listRetentionJournals({
  env = process.env,
  key,
  projectIdentityDigest,
}) {
  const root = retentionJournalsPath(env, projectIdentityDigest);
  await ensureRealDirectoryPath(root);
  const operations = (await fs.readdir(root)).sort();
  const chains = [];
  for (const operationId of operations) {
    const directory = path.join(root, operationId);
    await ensureRealDirectoryPath(directory);
    const names = (await fs.readdir(directory)).sort();
    if (
      names.length < 1 ||
      names.length > RETENTION_JOURNAL_FILES.length ||
      names.some((name, index) => name !== RETENTION_JOURNAL_FILES[index])
    ) {
      throw retentionError(
        'replay-retention-journal-chain-invalid',
        'retention journal chain is noncanonical',
      );
    }
    const entries = [];
    for (let sequence = 0; sequence < names.length; sequence += 1) {
      const raw = await readBoundedRegularFile(
        path.join(directory, names[sequence]),
        { maxBytes: REPLAY_METADATA_BYTES },
      );
      if (raw === null) {
        throw retentionError(
          'replay-retention-journal-chain-invalid',
          'retention journal transition disappeared',
        );
      }
      entries.push(parseRetentionJournalEntry(raw, {
        key,
        operationId,
        projectIdentityDigest,
        sequence,
        previous: entries.at(-1),
      }));
    }
    chains.push(Object.freeze({
      operationId,
      entries: Object.freeze(entries),
      latest: entries.at(-1),
      complete: entries.length === RETENTION_JOURNAL_FILES.length,
    }));
  }
  return Object.freeze(chains);
}

function position(current, before, after) {
  const digest = replayArtifactDigest(current);
  if (digest === before) return 'before';
  if (digest === after) return 'after';
  return 'third';
}

async function removeExactReplayRecord({
  env,
  key,
  projectIdentityDigest,
  record,
}) {
  const current = await readReplayRecord({
    env,
    key,
    projectIdentityDigest,
    replayIdentity: record.replayIdentity,
  });
  if (replayArtifactDigest(current) !== replayArtifactDigest(record)) {
    throw retentionError(
      'replay-retention-record-conflict',
      'retention record changed before removal',
    );
  }
  await fs.unlink(path.join(
    replayProjectPaths({ env, projectIdentityDigest }).records,
    `${record.replayIdentity.slice(7)}.json`,
  ));
}

export async function recoverRetentionJournal({
  env = process.env,
  key,
  projectIdentityDigest,
  chain,
  scope,
}) {
  if (chain.complete) return false;
  const intent = chain.entries[0];
  assertReplayMutationScope(scope, {
    projectIdentityDigest,
    replayIdentity: intent.replayIdentity,
  });
  const record = await readReplayRecord({
    env,
    key,
    projectIdentityDigest,
    replayIdentity: intent.replayIdentity,
  });
  const checkpoint = await readRetentionCheckpoint({
    env,
    key,
    projectIdentityDigest,
  });
  const manifest = await readReplayManifest({
    env,
    key,
    projectIdentityDigest,
  });
  const recordPosition = position(
    record,
    intent.priorRecordDigest,
    replayArtifactDigest(null),
  );
  const checkpointPosition = position(
    checkpoint,
    intent.priorCheckpointDigest,
    intent.nextCheckpointDigest,
  );
  const manifestPosition = position(
    manifest,
    intent.priorManifestDigest,
    intent.nextManifestDigest,
  );
  const sequence = chain.latest.sequence;
  const legal =
    (sequence === 0 &&
      recordPosition === 'before' &&
      checkpointPosition === 'before' &&
      manifestPosition === 'before') ||
    (sequence === 1 &&
      recordPosition === 'before' &&
      checkpointPosition === 'after' &&
      manifestPosition === 'before') ||
    (sequence === 2 &&
      checkpointPosition === 'after' &&
      manifestPosition === 'after' &&
      ['before', 'after'].includes(recordPosition)) ||
    (sequence === 3 &&
      checkpointPosition === 'after' &&
      manifestPosition === 'after' &&
      recordPosition === 'after');
  if (!legal) {
    throw retentionError(
      'replay-retention-third-state',
      'retention recovery found an ambiguous artifact state',
    );
  }
  const base = retentionJournalBase(intent);
  let transition = chain.latest;
  let nextSequence = sequence;
  if (nextSequence === 0) {
    await writeCheckpoint({
      env,
      projectIdentityDigest,
      checkpoint: intent.nextCheckpoint,
    });
    transition = await appendRetentionTransition({
      env, key, base,
      state: RETENTION_JOURNAL_STATES[1],
      sequence: 1,
      previousMac: transition.mac,
    });
    nextSequence = 1;
  }
  if (nextSequence === 1) {
    await writeReplayManifest({
      env,
      projectIdentityDigest,
      manifest: intent.nextManifest,
    });
    transition = await appendRetentionTransition({
      env, key, base,
      state: RETENTION_JOURNAL_STATES[2],
      sequence: 2,
      previousMac: transition.mac,
    });
    nextSequence = 2;
  }
  if (nextSequence === 2) {
    if (recordPosition === 'before') {
      await removeExactReplayRecord({
        env, key, projectIdentityDigest, record: intent.record,
      });
    }
    transition = await appendRetentionTransition({
      env, key, base,
      state: RETENTION_JOURNAL_STATES[3],
      sequence: 3,
      previousMac: transition.mac,
    });
    nextSequence = 3;
  }
  if (nextSequence === 3) {
    await appendRetentionTransition({
      env, key, base,
      state: RETENTION_JOURNAL_STATES[4],
      sequence: 4,
      previousMac: transition.mac,
    });
  }
  return true;
}

async function commitRetentionEviction({
  env,
  key,
  projectIdentityDigest,
  scope,
  priorCheckpoint,
  priorManifest,
  retainedRecords,
  eviction,
  now,
  onStep,
}) {
  const accumulator = nextRetentionAccumulator(
    priorCheckpoint?.accumulator ?? INITIAL_RETENTION_ACCUMULATOR,
    eviction.record,
    eviction.reason,
  );
  const checkpoint = sealRecord(key, AUTH_DOMAINS.replayCheckpoint, {
    domain: AUTH_DOMAINS.replayCheckpoint,
    schema: 'noosphere.replay-retention',
    version: 1,
    projectIdentityDigest,
    retentionGeneration:
      (priorCheckpoint?.retentionGeneration ?? 0) + 1,
    totalEvictedRecords:
      (priorCheckpoint?.totalEvictedRecords ?? 0) + 1,
    mostRecentRetentionAt: now,
    maxAgePolicy: 'last-seen-90-days-v1',
    recordCountPolicy: 'maximum-4096-v1',
    accumulator,
    keyId: replayKeyId(key),
  });
  const manifest = sealRecord(key, AUTH_DOMAINS.replayManifest, {
    ...priorManifest,
    recordCount: retainedRecords.length,
    recordIndexDigest: recordIndexDigest(retainedRecords),
    retentionGeneration: checkpoint.retentionGeneration,
    retentionCheckpointDigest: retentionCheckpointDigest(checkpoint),
    mac: undefined,
  });
  const base = {
    operationId: randomUUID(),
    projectIdentityDigest,
    replayIdentity: eviction.record.replayIdentity,
    priorRecordDigest: replayArtifactDigest(eviction.record),
    priorCheckpointDigest: replayArtifactDigest(priorCheckpoint),
    priorManifestDigest: replayArtifactDigest(priorManifest),
    nextCheckpointDigest: retentionCheckpointDigest(checkpoint),
    nextManifestDigest: replayArtifactDigest(manifest),
    evictionReason: eviction.reason,
    retentionAt: now,
    keyId: replayKeyId(key),
    record: eviction.record,
    nextCheckpoint: checkpoint,
    nextManifest: manifest,
  };
  assertReplayMutationScope(scope, {
    projectIdentityDigest,
    replayIdentity: eviction.record.replayIdentity,
  });
  let transition = await appendRetentionTransition({
    env, key, base,
    state: RETENTION_JOURNAL_STATES[0],
    sequence: 0,
    previousMac: null,
  });
  await onStep('retention-prepared');
  await writeCheckpoint({ env, projectIdentityDigest, checkpoint });
  transition = await appendRetentionTransition({
    env, key, base,
    state: RETENTION_JOURNAL_STATES[1],
    sequence: 1,
    previousMac: transition.mac,
  });
  await onStep('retention-checkpoint-committed');
  await writeReplayManifest({ env, projectIdentityDigest, manifest });
  transition = await appendRetentionTransition({
    env, key, base,
    state: RETENTION_JOURNAL_STATES[2],
    sequence: 2,
    previousMac: transition.mac,
  });
  await onStep('retention-manifest-committed');
  await removeExactReplayRecord({
    env, key, projectIdentityDigest, record: eviction.record,
  });
  transition = await appendRetentionTransition({
    env, key, base,
    state: RETENTION_JOURNAL_STATES[3],
    sequence: 3,
    previousMac: transition.mac,
  });
  await onStep('retention-record-removed');
  await appendRetentionTransition({
    env, key, base,
    state: RETENTION_JOURNAL_STATES[4],
    sequence: 4,
    previousMac: transition.mac,
  });
  await onStep('retention-complete');
  return Object.freeze({ checkpoint, manifest });
}

export async function planReplayRetention({
  env = process.env,
  key,
  projectIdentityDigest,
  replayIdentity,
  now,
}) {
  const records = await listReplayRecords({
    env,
    key,
    projectIdentityDigest,
  });
  const insertingNewIdentity = !records.some(record =>
    record.replayIdentity === replayIdentity);
  const checkpoint = await readRetentionCheckpoint({
    env,
    key,
    projectIdentityDigest,
  });
  if (
    !insertingNewIdentity &&
    checkpoint &&
    Date.parse(now) - Date.parse(checkpoint.mostRecentRetentionAt) <
      RETENTION_POLICY.existingIdentityIntervalMs
  ) {
    return Object.freeze({ records, evictions: Object.freeze([]), skipped: true });
  }
  return Object.freeze({
    records,
    evictions: selectReplayRecordEvictions(records, {
      now,
      insertingNewIdentity,
    }),
    skipped: false,
  });
}

export async function applyReplayRetention({
  env = process.env,
  key,
  projectIdentityDigest,
  replayIdentity,
  scope,
  now,
  onStep = () => {},
}) {
  assertReplayMutationScope(scope, {
    projectIdentityDigest,
    replayIdentity,
  });
  const plan = await planReplayRetention({
    env,
    key,
    projectIdentityDigest,
    replayIdentity,
    now,
  });
  if (plan.skipped) return Object.freeze({ evictedRecords: 0, evictedJournals: 0 });
  const journals = await listReplayJournals({
    env,
    key,
    projectIdentityDigest,
  });
  const retentionJournals = await listRetentionJournals({
    env,
    key,
    projectIdentityDigest,
  });
  const allJournalIds = [
    ...journals.map(item => item.operationId),
    ...retentionJournals.map(item => item.operationId),
  ];
  if (new Set(allJournalIds).size !== allJournalIds.length) {
    throw retentionError(
      'replay-journal-operation-conflict',
      'journal operation identities conflict across stores',
    );
  }
  const completedJournalIds = selectCompletedJournalEvictions(
    [
      ...journals,
      ...retentionJournals.map(chain => ({
        operationId: chain.operationId,
        complete: chain.complete,
        latest: {
          transitionAt: chain.latest.retentionAt,
        },
      })),
    ],
    { now },
  );
  const observationIds = new Set(journals.map(item => item.operationId));
  for (const operationId of completedJournalIds) {
    const root = observationIds.has(operationId)
      ? replayProjectPaths({ env, projectIdentityDigest }).journals
      : retentionJournalsPath(env, projectIdentityDigest);
    await fs.rm(path.join(root, operationId), { recursive: true });
  }
  if (plan.evictions.length === 0) {
    return Object.freeze({
      evictedRecords: 0,
      evictedJournals: completedJournalIds.length,
    });
  }

  let priorCheckpoint = await readRetentionCheckpoint({
    env,
    key,
    projectIdentityDigest,
  });
  let priorManifest = await readReplayManifest({
    env,
    key,
    projectIdentityDigest,
  });
  let retained = [...plan.records];
  for (const eviction of plan.evictions) {
    retained = retained.filter(record =>
      record.replayIdentity !== eviction.record.replayIdentity);
    const committed = await commitRetentionEviction({
      env,
      key,
      projectIdentityDigest,
      scope,
      priorCheckpoint,
      priorManifest,
      retainedRecords: retained,
      eviction,
      now,
      onStep,
    });
    priorCheckpoint = committed.checkpoint;
    priorManifest = committed.manifest;
  }
  return Object.freeze({
    evictedRecords: plan.evictions.length,
    evictedJournals: completedJournalIds.length,
  });
}
