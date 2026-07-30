import { createHash } from 'node:crypto';

import { AUTH_DOMAINS, verifyRecord } from '../authenticated-records.js';
import {
  is,
  parseAuthenticatedRecord,
} from '../strict-schema.js';
import {
  TrustStoreError,
  canonicalize,
} from '../../trust-store-internal.js';
import {
  REPLAY_CLASSIFICATIONS,
  REPLAY_METADATA_BYTES,
  REPLAY_ORIGINS,
  REPLAY_RECORD_BYTES,
  REPLAY_SLOTS,
  REPLAY_STATES,
} from './constants.js';

const SHA256_ID = /^sha256:[0-9a-f]{64}$/;
const UTC_MILLISECONDS =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EVENT_FIELDS = new Set([
  'eventId',
  'observedAt',
  'recallIdentity',
]);

function isCanonicalProjectList(value) {
  return Array.isArray(value) &&
    value.every(isSha256Id) &&
    value.every((entry, index) =>
      index === 0 || value[index - 1] < entry);
}

const REPLAY_CATALOG_SCHEMA = Object.freeze({
  domain: value => value === AUTH_DOMAINS.replayCatalog,
  schema: value => value === 'noosphere.replay-catalog',
  version: value => value === 1,
  projects: isCanonicalProjectList,
  keyId: is.hex64,
  mac: is.hex64,
});

const REPLAY_MANIFEST_SCHEMA = Object.freeze({
  domain: value => value === AUTH_DOMAINS.replayManifest,
  schema: value => value === 'noosphere.replay-manifest',
  version: value => value === 1,
  projectIdentityDigest: isSha256Id,
  recordCount: is.nonNegInt,
  recordIndexDigest: isSha256Id,
  retentionGeneration: is.nonNegInt,
  retentionCheckpointDigest: is.nullable(isSha256Id),
  lastRecoveredAt: is.nullable(isCanonicalTimestamp),
  keyId: is.hex64,
  mac: is.hex64,
});

function replayError(code, message) {
  return new TrustStoreError(code, message);
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function isSha256Id(value) {
  return typeof value === 'string' && SHA256_ID.test(value);
}

function isCanonicalTimestamp(value) {
  if (typeof value !== 'string' || !UTC_MILLISECONDS.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isSeenEvent(value) {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === EVENT_FIELDS.size &&
    Object.keys(value).every(field => EVENT_FIELDS.has(field)) &&
    is.uuid(value.eventId) &&
    isCanonicalTimestamp(value.observedAt) &&
    isSha256Id(value.recallIdentity);
}

const REPLAY_RECORD_SCHEMA = Object.freeze({
  domain: value => value === AUTH_DOMAINS.replayRecord,
  schema: value => value === 'noosphere.replay-record',
  version: value => value === 1,
  replayIdentity: isSha256Id,
  projectIdentityDigest: isSha256Id,
  slot: is.enumOf(new Set(REPLAY_SLOTS)),
  payloadDigest: isSha256Id,
  recallIdentity: isSha256Id,
  firstSeen: isSeenEvent,
  lastSeen: isSeenEvent,
  replayCount: is.posInt,
  state: is.enumOf(new Set(REPLAY_STATES)),
  lastClassification: is.enumOf(new Set(REPLAY_CLASSIFICATIONS)),
  origin: is.enumOf(new Set(REPLAY_ORIGINS)),
  recordGeneration: is.posInt,
  keyId: is.hex64,
  mac: is.hex64,
});

function expectedReplayIdentity(record) {
  return sha256(Buffer.from(canonicalize([
    'noosphere.replay-identity.v1',
    record.projectIdentityDigest,
    record.slot,
    record.payloadDigest,
  ]), 'utf8'));
}

function validateRecordConsistency(record) {
  if (record.replayIdentity !== expectedReplayIdentity(record)) {
    throw replayError(
      'replay-record-identity-invalid',
      'replay record identity does not match its canonical digest inputs',
    );
  }
  if (record.replayCount !== record.recordGeneration) {
    throw replayError(
      'replay-record-generation-invalid',
      'replay count and record generation must advance together',
    );
  }
  if (
    (record.replayCount === 1 && record.state !== 'SeenOnce') ||
    (record.replayCount >= 2 && record.state !== 'Replayed')
  ) {
    throw replayError(
      'replay-record-state-invalid',
      'replay state does not match replay count',
    );
  }
  const allowedClassification =
    record.replayCount === 1
      ? record.lastClassification === 'NEW'
      : record.replayCount === 2
        ? ['SEEN', 'SUPPRESSED'].includes(record.lastClassification)
        : ['REPLAYED', 'SUPPRESSED'].includes(record.lastClassification);
  if (!allowedClassification) {
    throw replayError(
      'replay-record-classification-invalid',
      'replay classification does not match replay count',
    );
  }
  if (record.recallIdentity !== record.lastSeen.recallIdentity) {
    throw replayError(
      'replay-record-recall-invalid',
      'current recall identity must match last-seen evidence',
    );
  }
  if (
    Date.parse(record.lastSeen.observedAt) <
      Date.parse(record.firstSeen.observedAt)
  ) {
    throw replayError(
      'replay-record-time-invalid',
      'last-seen time precedes first-seen time',
    );
  }
}

export function parseReplayRecord(raw, {
  key,
  expectedProjectIdentityDigest,
  expectedReplayIdentity: expectedIdentity,
  expectedKeyId,
}) {
  const record = parseAuthenticatedRecord(raw, {
    type: 'replay record',
    maxBytes: REPLAY_RECORD_BYTES,
    schema: REPLAY_RECORD_SCHEMA,
  });
  if (
    record.projectIdentityDigest !== expectedProjectIdentityDigest ||
    record.replayIdentity !== expectedIdentity ||
    record.keyId !== expectedKeyId
  ) {
    throw replayError(
      'replay-record-binding-invalid',
      'replay record does not match its expected local binding',
    );
  }
  validateRecordConsistency(record);
  if (!verifyRecord(key, AUTH_DOMAINS.replayRecord, record)) {
    throw replayError(
      'replay-record-mac-invalid',
      'replay record authentication failed',
    );
  }
  return record;
}

export function parseReplayCatalog(raw, {
  key,
  expectedKeyId,
}) {
  const catalog = parseAuthenticatedRecord(raw, {
    type: 'replay catalog',
    maxBytes: REPLAY_METADATA_BYTES,
    schema: REPLAY_CATALOG_SCHEMA,
  });
  if (catalog.keyId !== expectedKeyId) {
    throw replayError(
      'replay-catalog-key-invalid',
      'replay catalog does not match the replay key identity',
    );
  }
  if (!verifyRecord(key, AUTH_DOMAINS.replayCatalog, catalog)) {
    throw replayError(
      'replay-catalog-mac-invalid',
      'replay catalog authentication failed',
    );
  }
  return catalog;
}

export function parseReplayManifest(raw, {
  key,
  expectedProjectIdentityDigest,
  expectedKeyId,
}) {
  const manifest = parseAuthenticatedRecord(raw, {
    type: 'replay manifest',
    maxBytes: REPLAY_METADATA_BYTES,
    schema: REPLAY_MANIFEST_SCHEMA,
  });
  if (
    manifest.projectIdentityDigest !== expectedProjectIdentityDigest ||
    manifest.keyId !== expectedKeyId
  ) {
    throw replayError(
      'replay-manifest-binding-invalid',
      'replay manifest does not match its expected local binding',
    );
  }
  if (!verifyRecord(key, AUTH_DOMAINS.replayManifest, manifest)) {
    throw replayError(
      'replay-manifest-mac-invalid',
      'replay manifest authentication failed',
    );
  }
  return manifest;
}
