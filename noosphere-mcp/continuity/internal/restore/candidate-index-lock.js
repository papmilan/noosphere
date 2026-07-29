import { createHash } from 'node:crypto';
import path from 'node:path';

import { inspectOwnerOnlyDestination } from '../../secure-fs.js';
import {
  canonicalize,
  machineKeyId,
} from '../../trust-store-internal.js';
import { AUTH_DOMAINS } from '../authenticated-records.js';
import {
  acquireAuthenticatedRankedFileLock,
} from '../replay/lock.js';
import {
  LOCK_RANKS,
} from '../replay/lock-ranks.js';
import { RESTORE_SLOTS } from './constants.js';

const SHA256_ID = /^sha256:[0-9a-f]{64}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const INPUT_FIELDS = new Set([
  'candidatePayloadHash',
  'key',
  'projectIdentityDigest',
  'root',
  'scope',
  'slot',
]);
const LOCK_FIELDS = new Set([
  'candidatePayloadHash',
  'domain',
  'keyId',
  'mac',
  'projectIdentityDigest',
  'schema',
  'slot',
  'token',
  'version',
]);

function assertExactInput(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    Reflect.ownKeys(input).length !== INPUT_FIELDS.size ||
    !Reflect.ownKeys(input).every(field =>
      typeof field === 'string' && INPUT_FIELDS.has(field))
  ) {
    throw new TypeError(
      'candidate-index lock input must contain exactly scope, root, key, projectIdentityDigest, slot, and candidatePayloadHash',
    );
  }
}

function validateCandidateIndexLock(record, expected) {
  return record &&
    typeof record === 'object' &&
    !Array.isArray(record) &&
    Object.keys(record).length === LOCK_FIELDS.size &&
    Object.keys(record).every(field => LOCK_FIELDS.has(field)) &&
    record.domain === AUTH_DOMAINS.restoreCandidateIndexLock &&
    record.schema === 'noosphere.restore-candidate-index-lock' &&
    record.version === 1 &&
    record.projectIdentityDigest === expected.projectIdentityDigest &&
    record.slot === expected.slot &&
    record.candidatePayloadHash === expected.candidatePayloadHash &&
    record.keyId === expected.keyId &&
    record.token === expected.token &&
    typeof record.mac === 'string' &&
    /^[0-9a-f]{64}$/.test(record.mac);
}

function indexDigest({
  projectIdentityDigest,
  slot,
  candidatePayloadHash,
}) {
  return createHash('sha256').update(canonicalize([
    'noosphere.restore-candidate-index-lock-path.v1',
    projectIdentityDigest,
    slot,
    candidatePayloadHash,
  ])).digest('hex');
}

export async function acquireCandidateIndexLock(input) {
  assertExactInput(input);
  const {
    scope,
    root,
    key,
    projectIdentityDigest,
    slot,
    candidatePayloadHash,
  } = input;
  if (
    typeof root !== 'string' ||
    !Buffer.isBuffer(key) ||
    key.length !== 32 ||
    !SHA256_ID.test(projectIdentityDigest) ||
    !Object.hasOwn(RESTORE_SLOTS, slot) ||
    !HEX_64.test(candidatePayloadHash)
  ) {
    throw new TypeError('candidate-index lock binding is invalid');
  }
  const directory = path.join(root, 'candidate-index-locks');
  await inspectOwnerOnlyDestination(
    path.join(root, '.candidate-index-lock-boundary-probe'),
    { maxBytes: 0 },
  );
  const lockKey =
    `restore-candidate-index:${projectIdentityDigest}:${slot}:` +
    candidatePayloadHash;
  const fields = {
    domain: AUTH_DOMAINS.restoreCandidateIndexLock,
    schema: 'noosphere.restore-candidate-index-lock',
    version: 1,
    projectIdentityDigest,
    slot,
    candidatePayloadHash,
    keyId: machineKeyId(key),
  };
  return acquireAuthenticatedRankedFileLock({
    scope,
    rank: LOCK_RANKS.restoreCandidateIndex,
    lockKey,
    file: path.join(directory, `${indexDigest(input)}.lock`),
    authKey: key,
    domain: AUTH_DOMAINS.restoreCandidateIndexLock,
    fields,
    validate: validateCandidateIndexLock,
    busyCode: 'restore-candidate-index-lock-busy',
    malformedCode: 'restore-candidate-index-lock-malformed',
  });
}
