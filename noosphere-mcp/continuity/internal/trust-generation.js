import { AUTH_DOMAINS } from './authenticated-records.js';
import { TrustStoreError } from '../trust-store-internal.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SLOTS = new Set(['master-prompt', 'instructions', 'baseline']);
const FORBIDDEN_TOMBSTONE_FIELDS = Object.freeze([
  'rawHash',
  'contentHash',
  'byteLength',
  'normAlgo',
  'normVersion',
]);
const REVOKED_FIELDS = new Set([
  'auditEventId',
  'createdAt',
  'domain',
  'generation',
  'keyIdentity',
  'ownerScope',
  'previousCurrentRecordHash',
  'previousCurrentRecordId',
  'previousGeneration',
  'projectIdentityDigest',
  'recordId',
  'schema',
  'slot',
  'sourceOrigin',
  'transition',
  'version',
]);
const APPROVED_FIELDS = new Set([
  'auditEventId',
  'contentHash',
  'createdAt',
  'domain',
  'generation',
  'keyIdentity',
  'normAlgo',
  'normVersion',
  'ownerScope',
  'previousCurrentRecordHash',
  'previousCurrentRecordId',
  'previousGeneration',
  'projectIdentityDigest',
  'rawHash',
  'recordId',
  'schema',
  'slot',
  'sourceOrigin',
  'transition',
  'version',
]);

function fail(code, message) {
  throw new TrustStoreError(code, message);
}

function hasExactOwnFields(value, expected) {
  const keys = Object.keys(value);
  const hasMac = keys.includes('mac');
  if (hasMac && (!HEX_64.test(value.mac) || keys.length !== expected.size + 1)) return false;
  if (!hasMac && keys.length !== expected.size) return false;
  return keys.every(key => key === 'mac' || expected.has(key));
}

function validCommon(value) {
  return UUID_V4.test(value.recordId) &&
    DIGEST.test(value.projectIdentityDigest) &&
    typeof value.ownerScope === 'string' &&
    value.ownerScope.length > 0 &&
    SLOTS.has(value.slot) &&
    Number.isInteger(value.generation) &&
    value.generation > 0 &&
    Number.isInteger(value.previousGeneration) &&
    value.previousGeneration === value.generation - 1 &&
    (value.previousCurrentRecordId === null || UUID_V4.test(value.previousCurrentRecordId)) &&
    (value.previousCurrentRecordHash === null || HEX_64.test(value.previousCurrentRecordHash)) &&
    HEX_64.test(value.keyIdentity) &&
    UUID_V4.test(value.auditEventId) &&
    RFC3339_UTC.test(value.createdAt) &&
    !Number.isNaN(Date.parse(value.createdAt)) &&
    typeof value.sourceOrigin === 'string' &&
    value.sourceOrigin.length > 0;
}

export function buildApprovedGeneration({
  recordId,
  projectIdentityDigest,
  ownerScope,
  slot,
  generation,
  previousGeneration,
  previousCurrentRecordId,
  previousCurrentRecordHash,
  keyIdentity,
  auditEventId,
  createdAt,
  sourceOrigin,
  rawHash,
  contentHash,
  normAlgo,
  normVersion,
}) {
  return Object.freeze({
    domain: AUTH_DOMAINS.approvedGeneration,
    schema: 'noosphere.sec05.approved-generation',
    version: 1,
    recordId,
    projectIdentityDigest,
    ownerScope,
    slot,
    generation,
    previousGeneration,
    previousCurrentRecordId,
    previousCurrentRecordHash,
    transition: 'approved',
    keyIdentity,
    auditEventId,
    createdAt,
    sourceOrigin,
    rawHash,
    contentHash,
    normAlgo,
    normVersion,
  });
}

export function buildRevokedGeneration({
  recordId,
  projectIdentityDigest,
  ownerScope,
  slot,
  generation,
  previousGeneration,
  previousCurrentRecordId,
  previousCurrentRecordHash,
  keyIdentity,
  auditEventId,
  createdAt,
  sourceOrigin,
}) {
  return Object.freeze({
    domain: AUTH_DOMAINS.revokedGeneration,
    schema: 'noosphere.sec05.revoked-generation',
    version: 1,
    recordId,
    projectIdentityDigest,
    ownerScope,
    slot,
    generation,
    previousGeneration,
    previousCurrentRecordId,
    previousCurrentRecordHash,
    transition: 'revoked',
    keyIdentity,
    auditEventId,
    createdAt,
    sourceOrigin,
  });
}

export function validateTrustGeneration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('trust-generation-invalid', 'trust generation must be an object');
  }
  if (value.domain === AUTH_DOMAINS.revokedGeneration) {
    if (FORBIDDEN_TOMBSTONE_FIELDS.some(field => field in value) ||
        !hasExactOwnFields(value, REVOKED_FIELDS) ||
        value.schema !== 'noosphere.sec05.revoked-generation' ||
        value.version !== 1 ||
        value.transition !== 'revoked' ||
        value.sourceOrigin !== `cli:trust-revoke:${value.slot}` ||
        !validCommon(value) ||
        value.previousGeneration < 1 ||
        value.previousCurrentRecordId === null ||
        value.previousCurrentRecordHash === null) {
      fail('revoked-generation-invalid', 'revoked generation schema is invalid');
    }
    return value;
  }
  if (value.domain === AUTH_DOMAINS.approvedGeneration) {
    if (!hasExactOwnFields(value, APPROVED_FIELDS) ||
        value.schema !== 'noosphere.sec05.approved-generation' ||
        value.version !== 1 ||
        value.transition !== 'approved' ||
        !validCommon(value) ||
        !HEX_64.test(value.rawHash) ||
        !HEX_64.test(value.contentHash) ||
        typeof value.normAlgo !== 'string' ||
        value.normAlgo.length === 0 ||
        !Number.isInteger(value.normVersion) ||
        value.normVersion < 1 ||
        (value.generation === 1
          ? value.previousCurrentRecordId !== null ||
            value.previousCurrentRecordHash !== null ||
            value.previousGeneration !== 0
          : value.previousCurrentRecordId === null ||
            value.previousCurrentRecordHash === null)) {
      fail('approved-generation-invalid', 'approved generation schema is invalid');
    }
    return value;
  }
  fail('trust-generation-invalid', 'trust generation domain is invalid');
}

export const TRUST_GENERATION_FIELDS = Object.freeze({
  approved: Object.freeze([...APPROVED_FIELDS]),
  revoked: Object.freeze([...REVOKED_FIELDS]),
});
