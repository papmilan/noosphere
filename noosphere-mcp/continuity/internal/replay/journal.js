import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
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
  readReplayManifest,
  readReplayRecord,
  replayArtifactDigest,
  replayProjectPaths,
  writeReplayManifest,
  writeReplayRecord,
} from './store.js';
import {
  parseReplayManifest,
  parseReplayRecord,
} from './schema.js';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_ID = /^sha256:[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const STATES = Object.freeze([
  'prepared',
  'record-committed',
  'manifest-committed',
  'complete',
]);
const FILES = Object.freeze([
  '00-prepared.json',
  '01-record-committed.json',
  '02-manifest-committed.json',
  '03-complete.json',
]);
const FIELDS = new Set([
  'domain',
  'schema',
  'version',
  'operationId',
  'state',
  'sequence',
  'previousMac',
  'projectIdentityDigest',
  'replayIdentity',
  'eventId',
  'priorRecordDigest',
  'priorManifestDigest',
  'nextRecordDigest',
  'nextManifestDigest',
  'intendedReplayCount',
  'intendedRecordGeneration',
  'intendedState',
  'intendedClassification',
  'observedAt',
  'transitionAt',
  'keyId',
  'nextRecord',
  'nextManifest',
  'mac',
]);

function journalError(code, message, cause) {
  const error = new TrustStoreError(code, message);
  if (cause !== undefined) error.cause = cause;
  return error;
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function nowIso(now) {
  return (now ? new Date(now) : new Date()).toISOString();
}

function journalDirectory({ env, projectIdentityDigest, operationId }) {
  return path.join(
    replayProjectPaths({ env, projectIdentityDigest }).journals,
    operationId,
  );
}

async function writeTransition({
  env,
  key,
  base,
  state,
  sequence,
  previousMac,
  transitionAt,
}) {
  const directory = journalDirectory({
    env,
    projectIdentityDigest: base.projectIdentityDigest,
    operationId: base.operationId,
  });
  await ensureRealDirectoryPath(directory);
  const entry = sealRecord(key, AUTH_DOMAINS.replayJournal, {
    ...base,
    domain: AUTH_DOMAINS.replayJournal,
    schema: 'noosphere.replay-journal',
    version: 1,
    state,
    sequence,
    previousMac,
    transitionAt: nowIso(transitionAt),
  });
  await writeOwnerOnlyFileExclusive(
    path.join(directory, FILES[sequence]),
    canonicalize(entry),
    {
      root: homeDir(env),
      maxBytes: REPLAY_METADATA_BYTES,
    },
  );
  return entry;
}

function baseFields(entry) {
  const {
    state: ignoredState,
    sequence: ignoredSequence,
    previousMac: ignoredPreviousMac,
    transitionAt: ignoredTransitionAt,
    mac: ignoredMac,
    ...base
  } = entry;
  return base;
}

function parseJournalEntry(raw, {
  key,
  expectedOperationId,
  expectedProjectIdentityDigest,
  expectedSequence,
  previous,
}) {
  let entry;
  try {
    const text = raw.toString('utf8');
    entry = JSON.parse(text);
    if (text !== canonicalize(entry)) {
      throw new Error('journal entry is noncanonical');
    }
  } catch (cause) {
    throw journalError('replay-journal-corrupt', 'replay journal is malformed', cause);
  }
  if (
    !entry ||
    typeof entry !== 'object' ||
    Array.isArray(entry) ||
    Object.keys(entry).length !== FIELDS.size ||
    !Object.keys(entry).every(field => FIELDS.has(field)) ||
    entry.domain !== AUTH_DOMAINS.replayJournal ||
    entry.schema !== 'noosphere.replay-journal' ||
    entry.version !== 1 ||
    entry.operationId !== expectedOperationId ||
    entry.projectIdentityDigest !== expectedProjectIdentityDigest ||
    entry.sequence !== expectedSequence ||
    entry.state !== STATES[expectedSequence] ||
    entry.previousMac !== (previous?.mac ?? null) ||
    !UUID_V4.test(entry.operationId) ||
    !UUID_V4.test(entry.eventId) ||
    !SHA256_ID.test(entry.projectIdentityDigest) ||
    !SHA256_ID.test(entry.replayIdentity) ||
    !SHA256_ID.test(entry.priorRecordDigest) ||
    !SHA256_ID.test(entry.priorManifestDigest) ||
    !SHA256_ID.test(entry.nextRecordDigest) ||
    !SHA256_ID.test(entry.nextManifestDigest) ||
    !Number.isSafeInteger(entry.intendedReplayCount) ||
    entry.intendedReplayCount < 1 ||
    entry.intendedRecordGeneration !== entry.intendedReplayCount ||
    !['SeenOnce', 'Replayed'].includes(entry.intendedState) ||
    !['NEW', 'SEEN', 'REPLAYED', 'SUPPRESSED'].includes(entry.intendedClassification) ||
    !canonicalTimestamp(entry.observedAt) ||
    !canonicalTimestamp(entry.transitionAt) ||
    entry.keyId !== replayKeyId(key) ||
    !HEX64.test(entry.mac) ||
    !verifyRecord(key, AUTH_DOMAINS.replayJournal, entry)
  ) {
    throw journalError('replay-journal-invalid', 'replay journal authentication or binding failed');
  }
  parseReplayRecord(Buffer.from(canonicalize(entry.nextRecord)), {
    key,
    expectedProjectIdentityDigest,
    expectedReplayIdentity: entry.replayIdentity,
    expectedKeyId: replayKeyId(key),
  });
  parseReplayManifest(Buffer.from(canonicalize(entry.nextManifest)), {
    key,
    expectedProjectIdentityDigest,
    expectedKeyId: replayKeyId(key),
  });
  if (
    replayArtifactDigest(entry.nextRecord) !== entry.nextRecordDigest ||
    replayArtifactDigest(entry.nextManifest) !== entry.nextManifestDigest ||
    entry.nextRecord.replayCount !== entry.intendedReplayCount ||
    entry.nextRecord.recordGeneration !== entry.intendedRecordGeneration ||
    entry.nextRecord.state !== entry.intendedState ||
    entry.nextRecord.lastClassification !== entry.intendedClassification ||
    entry.nextRecord.lastSeen.eventId !== entry.eventId
  ) {
    throw journalError('replay-journal-intent-invalid', 'replay journal intent is inconsistent');
  }
  if (
    previous &&
    canonicalize(baseFields(previous)) !== canonicalize(baseFields(entry))
  ) {
    throw journalError('replay-journal-spliced', 'replay journal transition was spliced');
  }
  return entry;
}

async function readJournalChain({
  env,
  key,
  projectIdentityDigest,
  operationId,
}) {
  if (!UUID_V4.test(operationId)) {
    throw journalError('replay-journal-entry-invalid', 'unsafe replay journal directory');
  }
  const directory = journalDirectory({
    env,
    projectIdentityDigest,
    operationId,
  });
  await ensureRealDirectoryPath(directory);
  const names = (await fs.readdir(directory)).sort();
  if (
    names.length < 1 ||
    names.length > FILES.length ||
    names.some((name, index) => name !== FILES[index])
  ) {
    throw journalError('replay-journal-chain-invalid', 'replay journal chain is incomplete or noncanonical');
  }
  const entries = [];
  for (let sequence = 0; sequence < names.length; sequence += 1) {
    const raw = await readBoundedRegularFile(
      path.join(directory, names[sequence]),
      { maxBytes: REPLAY_METADATA_BYTES },
    );
    if (raw === null) {
      throw journalError('replay-journal-chain-invalid', 'replay journal transition disappeared');
    }
    entries.push(parseJournalEntry(raw, {
      key,
      expectedOperationId: operationId,
      expectedProjectIdentityDigest: projectIdentityDigest,
      expectedSequence: sequence,
      previous: entries.at(-1),
    }));
  }
  return Object.freeze({
    operationId,
    entries: Object.freeze(entries),
    latest: entries.at(-1),
    complete: entries.length === FILES.length,
  });
}

export async function listReplayJournals({
  env = process.env,
  key,
  projectIdentityDigest,
}) {
  const root = replayProjectPaths({ env, projectIdentityDigest }).journals;
  await ensureRealDirectoryPath(root);
  const names = (await fs.readdir(root)).sort();
  const chains = [];
  for (const operationId of names) {
    chains.push(await readJournalChain({
      env,
      key,
      projectIdentityDigest,
      operationId,
    }));
  }
  return Object.freeze(chains);
}

export async function commitReplayJournalTransaction({
  env = process.env,
  key,
  projectIdentityDigest,
  replayIdentity,
  eventId,
  observedAt,
  priorRecord,
  priorManifest,
  nextRecord,
  nextManifest,
  scope,
  onStep = () => {},
}) {
  assertReplayMutationScope(scope, {
    projectIdentityDigest,
    replayIdentity,
  });
  const operationId = randomUUID();
  const base = {
    operationId,
    projectIdentityDigest,
    replayIdentity,
    eventId,
    priorRecordDigest: replayArtifactDigest(priorRecord),
    priorManifestDigest: replayArtifactDigest(priorManifest),
    nextRecordDigest: replayArtifactDigest(nextRecord),
    nextManifestDigest: replayArtifactDigest(nextManifest),
    intendedReplayCount: nextRecord.replayCount,
    intendedRecordGeneration: nextRecord.recordGeneration,
    intendedState: nextRecord.state,
    intendedClassification: nextRecord.lastClassification,
    observedAt,
    keyId: replayKeyId(key),
    nextRecord,
    nextManifest,
  };
  let transition = await writeTransition({
    env,
    key,
    base,
    state: STATES[0],
    sequence: 0,
    previousMac: null,
    transitionAt: observedAt,
  });
  await onStep(STATES[0]);
  await writeReplayRecord({ env, projectIdentityDigest, record: nextRecord });
  transition = await writeTransition({
    env,
    key,
    base,
    state: STATES[1],
    sequence: 1,
    previousMac: transition.mac,
  });
  await onStep(STATES[1]);
  await writeReplayManifest({ env, projectIdentityDigest, manifest: nextManifest });
  transition = await writeTransition({
    env,
    key,
    base,
    state: STATES[2],
    sequence: 2,
    previousMac: transition.mac,
  });
  await onStep(STATES[2]);
  await writeTransition({
    env,
    key,
    base,
    state: STATES[3],
    sequence: 3,
    previousMac: transition.mac,
  });
  await onStep(STATES[3]);
  return operationId;
}

function artifactPosition(current, beforeDigest, afterDigest) {
  const digest = replayArtifactDigest(current);
  if (digest === beforeDigest) return 'before';
  if (digest === afterDigest) return 'after';
  return 'third';
}

export async function recoverReplayJournal({
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
  const currentRecord = await readReplayRecord({
    env,
    key,
    projectIdentityDigest,
    replayIdentity: intent.replayIdentity,
  });
  const currentManifest = await readReplayManifest({
    env,
    key,
    projectIdentityDigest,
  });
  const recordPosition = artifactPosition(
    currentRecord,
    intent.priorRecordDigest,
    intent.nextRecordDigest,
  );
  const manifestPosition = artifactPosition(
    currentManifest,
    intent.priorManifestDigest,
    intent.nextManifestDigest,
  );
  const sequence = chain.latest.sequence;
  const legal =
    (sequence === 0 &&
      ((recordPosition === 'before' && manifestPosition === 'before') ||
       (recordPosition === 'after' && manifestPosition === 'before'))) ||
    (sequence === 1 &&
      recordPosition === 'after' &&
      ['before', 'after'].includes(manifestPosition)) ||
    (sequence === 2 &&
      recordPosition === 'after' &&
      manifestPosition === 'after');
  if (!legal) {
    throw journalError(
      'replay-journal-third-state',
      'replay recovery found an ambiguous artifact state',
    );
  }

  let transition = chain.latest;
  let nextSequence = sequence;
  if (recordPosition === 'before') {
    await writeReplayRecord({
      env,
      projectIdentityDigest,
      record: intent.nextRecord,
    });
  }
  if (nextSequence === 0) {
    transition = await writeTransition({
      env,
      key,
      base: baseFields(intent),
      state: STATES[1],
      sequence: 1,
      previousMac: transition.mac,
    });
    nextSequence = 1;
  }
  if (manifestPosition === 'before') {
    await writeReplayManifest({
      env,
      projectIdentityDigest,
      manifest: intent.nextManifest,
    });
  }
  if (nextSequence === 1) {
    transition = await writeTransition({
      env,
      key,
      base: baseFields(intent),
      state: STATES[2],
      sequence: 2,
      previousMac: transition.mac,
    });
    nextSequence = 2;
  }
  if (nextSequence === 2) {
    await writeTransition({
      env,
      key,
      base: baseFields(intent),
      state: STATES[3],
      sequence: 3,
      previousMac: transition.mac,
    });
  }
  return true;
}
