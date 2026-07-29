import { createHash } from 'node:crypto';

import { normalizeUntrusted } from '../../memory-safety.js';
import { canonicalize } from '../../trust-store-internal.js';
import { REPLAY_SLOTS } from './constants.js';

const PROJECT_IDENTITY_DIGEST = /^sha256:[0-9a-f]{64}$/;
const REPLAY_SLOT_SET = new Set(REPLAY_SLOTS);
const INPUT_FIELDS = [
  'content',
  'projectIdentityDigest',
  'slot',
];
const INPUT_FIELD_SET = new Set(INPUT_FIELDS);
const RECALL_INPUT_FIELDS = new Set([
  'actionId',
  'blobId',
  'payloadDigest',
]);
const AUDIT_METADATA_BYTES = 4_096;

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function assertExactInput(input) {
  const keys = input && typeof input === 'object'
    ? Reflect.ownKeys(input)
    : [];
  if (
    input === null ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    keys.length !== INPUT_FIELDS.length ||
    !keys.every(key => typeof key === 'string' && INPUT_FIELD_SET.has(key))
  ) {
    throw new TypeError(
      'replay identity input must contain exactly projectIdentityDigest, slot, and content',
    );
  }
}

export function deriveReplayIdentity(input) {
  assertExactInput(input);
  const { projectIdentityDigest, slot, content } = input;
  if (!PROJECT_IDENTITY_DIGEST.test(projectIdentityDigest)) {
    throw new TypeError('project identity digest is invalid');
  }
  if (!REPLAY_SLOT_SET.has(slot)) {
    throw new TypeError('replay slot is invalid');
  }
  if (typeof content !== 'string') {
    throw new TypeError('replay content must be a string');
  }

  const normalizedBytes = Buffer.from(normalizeUntrusted(content), 'utf8');
  const payloadDigest = sha256(normalizedBytes);
  const replayIdentity = sha256(Buffer.from(canonicalize([
    'noosphere.replay-identity.v1',
    projectIdentityDigest,
    slot,
    payloadDigest,
  ]), 'utf8'));

  return Object.freeze({
    normalizedBytes,
    payloadDigest,
    replayIdentity,
  });
}

function boundedAuditValue(value) {
  return typeof value === 'string' &&
    Buffer.byteLength(value, 'utf8') <= AUDIT_METADATA_BYTES
    ? value
    : null;
}

export function deriveRecallIdentity(input) {
  const keys = input && typeof input === 'object'
    ? Reflect.ownKeys(input)
    : [];
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    keys.length !== RECALL_INPUT_FIELDS.size ||
    !keys.every(key =>
      typeof key === 'string' && RECALL_INPUT_FIELDS.has(key)) ||
    typeof input.payloadDigest !== 'string' ||
    !PROJECT_IDENTITY_DIGEST.test(input.payloadDigest)
  ) {
    throw new TypeError('recall identity input is invalid');
  }
  return sha256(Buffer.from(canonicalize([
    'noosphere.remote-recall-identity.v1',
    boundedAuditValue(input.actionId),
    boundedAuditValue(input.blobId),
    input.payloadDigest,
  ]), 'utf8'));
}
