import fs from 'node:fs/promises';
import path from 'node:path';

import {
  ensureRealDirectoryPath,
  readBoundedRegularFile,
  writeOwnerOnlyFileExclusive,
} from '../../secure-fs.js';
import { TrustStoreError, canonicalize } from '../../trust-store-internal.js';
import { AUTH_DOMAINS, sealRecord, verifyRecord } from '../authenticated-records.js';
import { createFormatV2Store } from '../trust-format-v2.js';
import { decodeCanonicalCandidateId } from './cli.js';
import { RESTORE_RECORD_BYTES, RESTORE_SLOTS } from './constants.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const IDENTITY = /^sha256:[0-9a-f]{64}$/;
const RECEIPT_FIELDS = new Set([
  'authoritative',
  'candidateId',
  'candidatePayloadHash',
  'contextId',
  'createdAt',
  'destinationHash',
  'domain',
  'keyId',
  'mac',
  'outcome',
  'projectIdentityDigest',
  'receiptId',
  'schema',
  'slot',
  'transactionId',
  'version',
]);
const MARKER_FIELDS = new Set([
  'candidateId',
  'candidatePayloadHash',
  'contextId',
  'createdAt',
  'domain',
  'keyId',
  'mac',
  'outcome',
  'projectIdentityDigest',
  'receiptId',
  'schema',
  'slot',
  'transactionId',
  'version',
]);
const UTF8 = new TextDecoder('utf-8', { fatal: true });

function receiptError(message) {
  return new TrustStoreError('ERR_RESTORE_RECEIPT_INVALID', message);
}

function exactFields(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.size &&
    Object.keys(value).every(key => fields.has(key));
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function validCommon(record, expected) {
  return record.candidateId === expected.candidateId &&
    record.transactionId === expected.transactionId &&
    record.contextId === expected.contextId &&
    record.projectIdentityDigest === expected.projectIdentityDigest &&
    record.keyId === expected.keyId &&
    record.slot === expected.slot &&
    HASH.test(record.candidatePayloadHash) &&
    UUID.test(record.transactionId) &&
    UUID.test(record.contextId) &&
    IDENTITY.test(record.projectIdentityDigest) &&
    HASH.test(record.keyId) &&
    Object.hasOwn(RESTORE_SLOTS, record.slot) &&
    canonicalTimestamp(record.createdAt);
}

function receiptPaths(store, binding, { receiptId, candidateId }) {
  return Object.freeze({
    receiptsRoot: store.pathFor(binding, path.join('restore', 'receipts')),
    receipt: receiptId
      ? store.pathFor(binding, path.join('restore', 'receipts', `${receiptId}.json`))
      : null,
    consumedRoot: store.pathFor(binding, path.join('restore', 'consumed')),
    marker: candidateId
      ? store.pathFor(binding, path.join('restore', 'consumed', `${candidateId}.json`))
      : null,
  });
}

async function readCanonical(file, missingAllowed, secureFileOptions) {
  let bytes;
  try {
    bytes = await readBoundedRegularFile(file, {
      maxBytes: RESTORE_RECORD_BYTES,
      ...secureFileOptions,
    });
  } catch (error) {
    throw receiptError(`restore receipt path is unsafe: ${error.code ?? 'read-failed'}`);
  }
  if (bytes === null) {
    if (missingAllowed) return null;
    throw receiptError('restore receipt or consumed marker is missing');
  }
  let text;
  let parsed;
  try {
    text = UTF8.decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    throw receiptError('restore receipt or consumed marker is malformed');
  }
  if (text !== canonicalize(parsed)) {
    throw receiptError('restore receipt or consumed marker is not canonical');
  }
  return parsed;
}

async function contextFor(projectRoot, env, secureFileOptions, create = false) {
  const store = createFormatV2Store({ env, secureFileOptions });
  const binding = create
    ? await store.createProjectBinding(projectRoot)
    : await store.readProjectBinding(projectRoot);
  return {
    store,
    binding,
    key: await store.ensureMachineKey(),
    projectIdentityDigest: await store.canonicalProjectIdentityDigest(projectRoot),
  };
}

function publicRecord(record, file) {
  return Object.freeze({ ...record, path: file });
}

export async function readRestoreReceipt({
  projectRoot,
  env = process.env,
  secureFileOptions = {},
  receiptId,
  missingAllowed = false,
} = {}) {
  if (!UUID.test(receiptId)) throw receiptError('restore receipt ID is invalid');
  const context = await contextFor(projectRoot, env, secureFileOptions);
  const file = receiptPaths(context.store, context.binding, { receiptId }).receipt;
  const receipt = await readCanonical(file, missingAllowed, secureFileOptions);
  if (receipt === null) return null;
  const expected = {
    candidateId: receipt.candidateId,
    transactionId: receiptId,
    contextId: receipt.contextId,
    projectIdentityDigest: context.projectIdentityDigest,
    keyId: context.binding.keyId,
    slot: receipt.slot,
  };
  if (!exactFields(receipt, RECEIPT_FIELDS) ||
      receipt.domain !== AUTH_DOMAINS.restoreReceipt ||
      receipt.schema !== 'noosphere.restore-consumption-receipt' ||
      receipt.version !== 1 ||
      receipt.receiptId !== receiptId ||
      receipt.outcome !== 'applied' ||
      typeof receipt.authoritative !== 'boolean' ||
      !HASH.test(receipt.destinationHash) ||
      !validCommon(receipt, expected) ||
      !verifyRecord(context.key, AUTH_DOMAINS.restoreReceipt, receipt)) {
    throw receiptError('restore receipt is invalid or unauthenticated');
  }
  decodeCanonicalCandidateId(receipt.candidateId);
  return publicRecord(receipt, file);
}

export async function commitRestoreReceipt({
  projectRoot,
  env = process.env,
  secureFileOptions = {},
  receiptId,
  transactionId,
  contextId,
  candidateId,
  candidatePayloadHash,
  destinationHash,
  slot,
  outcome,
  authoritative,
  now = () => new Date(),
} = {}) {
  decodeCanonicalCandidateId(candidateId);
  if (!UUID.test(receiptId) || receiptId !== transactionId ||
      !UUID.test(contextId) || !HASH.test(candidatePayloadHash) ||
      !HASH.test(destinationHash) || !Object.hasOwn(RESTORE_SLOTS, slot) ||
      outcome !== 'applied' || typeof authoritative !== 'boolean') {
    throw receiptError('restore receipt input is invalid');
  }
  const context = await contextFor(projectRoot, env, secureFileOptions, true);
  const paths = receiptPaths(context.store, context.binding, { receiptId });
  await ensureRealDirectoryPath(paths.receiptsRoot);
  const observedNow = now();
  if (!(observedNow instanceof Date) || Number.isNaN(observedNow.getTime())) {
    throw receiptError('restore receipt time is invalid');
  }
  const receipt = sealRecord(context.key, AUTH_DOMAINS.restoreReceipt, {
    domain: AUTH_DOMAINS.restoreReceipt,
    schema: 'noosphere.restore-consumption-receipt',
    version: 1,
    receiptId,
    transactionId,
    contextId,
    candidateId,
    candidatePayloadHash,
    destinationHash,
    slot,
    outcome,
    authoritative,
    projectIdentityDigest: context.projectIdentityDigest,
    keyId: context.binding.keyId,
    createdAt: observedNow.toISOString(),
  });
  try {
    await writeOwnerOnlyFileExclusive(
      paths.receipt,
      canonicalize(receipt),
      secureFileOptions,
    );
  } catch (error) {
    if (error.code !== 'state-file-exists' && error.code !== 'EEXIST') throw error;
    const existing = await readRestoreReceipt({
      projectRoot,
      env,
      secureFileOptions,
      receiptId,
    });
    const { path: ignoredPath, createdAt: ignoredCreatedAt, mac: ignoredMac, ...existingFields } = existing;
    const { createdAt: ignoredNewCreatedAt, mac: ignoredNewMac, ...newFields } = receipt;
    if (canonicalize(existingFields) !== canonicalize(newFields)) {
      throw receiptError('conflicting restore receipt already exists');
    }
    return existing;
  }
  return readRestoreReceipt({ projectRoot, env, secureFileOptions, receiptId });
}

export async function readConsumedMarker({
  projectRoot,
  env = process.env,
  secureFileOptions = {},
  candidateId,
  missingAllowed = false,
} = {}) {
  decodeCanonicalCandidateId(candidateId);
  const context = await contextFor(projectRoot, env, secureFileOptions);
  const file = receiptPaths(context.store, context.binding, { candidateId }).marker;
  const marker = await readCanonical(file, missingAllowed, secureFileOptions);
  if (marker === null) return null;
  const expected = {
    candidateId,
    transactionId: marker.transactionId,
    contextId: marker.contextId,
    projectIdentityDigest: context.projectIdentityDigest,
    keyId: context.binding.keyId,
    slot: marker.slot,
  };
  if (!exactFields(marker, MARKER_FIELDS) ||
      marker.domain !== AUTH_DOMAINS.restoreConsumed ||
      marker.schema !== 'noosphere.restore-consumed-candidate-marker' ||
      marker.version !== 1 ||
      marker.candidateId !== candidateId ||
      !['applied', 'failed-before-replacement'].includes(marker.outcome) ||
      (marker.receiptId !== null && !UUID.test(marker.receiptId)) ||
      (marker.outcome === 'applied') !== (marker.receiptId !== null) ||
      !validCommon(marker, expected) ||
      !verifyRecord(context.key, AUTH_DOMAINS.restoreConsumed, marker)) {
    throw receiptError('restore consumed marker is invalid or unauthenticated');
  }
  return publicRecord(marker, file);
}

export async function commitConsumedMarker({
  projectRoot,
  env = process.env,
  secureFileOptions = {},
  transactionId,
  contextId,
  candidateId,
  candidatePayloadHash,
  slot,
  outcome,
  receiptId = null,
  now = () => new Date(),
} = {}) {
  decodeCanonicalCandidateId(candidateId);
  if (!UUID.test(transactionId) || !UUID.test(contextId) ||
      !HASH.test(candidatePayloadHash) || !Object.hasOwn(RESTORE_SLOTS, slot) ||
      !['applied', 'failed-before-replacement'].includes(outcome) ||
      (outcome === 'applied'
        ? receiptId !== transactionId
        : receiptId !== null)) {
    throw receiptError('restore consumed marker input is invalid');
  }
  const context = await contextFor(projectRoot, env, secureFileOptions, true);
  const paths = receiptPaths(context.store, context.binding, { candidateId });
  await ensureRealDirectoryPath(paths.consumedRoot);
  const observedNow = now();
  if (!(observedNow instanceof Date) || Number.isNaN(observedNow.getTime())) {
    throw receiptError('restore consumed marker time is invalid');
  }
  const marker = sealRecord(context.key, AUTH_DOMAINS.restoreConsumed, {
    domain: AUTH_DOMAINS.restoreConsumed,
    schema: 'noosphere.restore-consumed-candidate-marker',
    version: 1,
    candidateId,
    candidatePayloadHash,
    transactionId,
    contextId,
    slot,
    outcome,
    receiptId,
    projectIdentityDigest: context.projectIdentityDigest,
    keyId: context.binding.keyId,
    createdAt: observedNow.toISOString(),
  });
  try {
    await writeOwnerOnlyFileExclusive(
      paths.marker,
      canonicalize(marker),
      secureFileOptions,
    );
  } catch (error) {
    if (error.code !== 'state-file-exists' && error.code !== 'EEXIST') throw error;
    const existing = await readConsumedMarker({
      projectRoot,
      env,
      secureFileOptions,
      candidateId,
    });
    const { path: ignoredPath, createdAt: ignoredCreatedAt, mac: ignoredMac, ...existingFields } = existing;
    const { createdAt: ignoredNewCreatedAt, mac: ignoredNewMac, ...newFields } = marker;
    if (canonicalize(existingFields) !== canonicalize(newFields)) {
      throw receiptError('conflicting consumed marker already exists');
    }
    return existing;
  }
  return readConsumedMarker({
    projectRoot,
    env,
    secureFileOptions,
    candidateId,
  });
}

export async function classifyRestoreReceipt(input) {
  const receipt = await readRestoreReceipt(input);
  return Object.freeze({
    classification: 'audit-only',
    slot: receipt.slot,
    outcome: receipt.outcome,
    destinationHash: receipt.destinationHash,
    transactionId: receipt.transactionId,
    authoritative: receipt.authoritative,
  });
}
