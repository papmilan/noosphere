import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { readOwnerOnlyFile } from '../secure-fs.js';
import {
  MAX_TRUST_RECORD_BYTES,
  canonicalize,
  homeDir,
  ownerScope,
} from '../trust-store-internal.js';
import { AUTH_DOMAINS } from './authenticated-records.js';

const LEGACY_SLOTS = Object.freeze([
  'master-prompt',
  'instructions',
  'followups',
  'baseline',
]);
const AUTHORITY_SLOTS = new Set(['master-prompt', 'instructions', 'baseline']);
const PHASE4B_KEYS = Object.freeze({
  binding: new Set([
    'format', 'keyId', 'mac', 'ownerScope', 'projectIdentity', 'realpathHash', 'type',
  ]),
  record: new Set([
    'approvalEventId', 'approvedAt', 'auditEventId', 'contentHash', 'format',
    'generation', 'keyId', 'mac', 'normAlgo', 'normVersion', 'ownerScope',
    'previousRecordId', 'projectIdentity', 'rawHash', 'recordId', 'slot',
    'sourceOrigin', 'type',
  ]),
  manifest: new Set([
    'auditHeadHash', 'auditHeadId', 'currentGeneration', 'currentRecordHash',
    'currentRecordId', 'format', 'keyId', 'mac', 'ownerScope', 'projectIdentity',
    'slot', 'type',
  ]),
  audit: new Set([
    'contentHash', 'eventId', 'eventType', 'format', 'generation', 'keyId', 'mac',
    'normAlgo', 'normVersion', 'ownerScope', 'previousAuditEventHash',
    'previousAuditEventId', 'previousGeneration', 'previousRecordId',
    'projectIdentity', 'rawHash', 'recordHash', 'recordId', 'slot', 'timestamp',
    'type',
  ]),
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function validMac(key, record) {
  if (!record || typeof record.mac !== 'string' ||
      !/^[0-9a-f]{64}$/.test(record.mac)) {
    return false;
  }
  const { mac, ...fields } = record;
  const expected = Buffer.from(
    createHmac('sha256', key).update(canonicalize(fields), 'utf8').digest('hex'),
    'hex',
  );
  return timingSafeEqual(expected, Buffer.from(mac, 'hex'));
}

function phase4bMacValid(key, type, record) {
  if (!record || typeof record.mac !== 'string' ||
      !/^[0-9a-f]{64}$/.test(record.mac)) {
    return false;
  }
  const { mac, ...fields } = record;
  const expected = Buffer.from(
    createHmac('sha256', key)
      .update(`noosphere/sec05/v2/${type}\0${canonicalize(fields)}`, 'utf8')
      .digest('hex'),
    'hex',
  );
  return timingSafeEqual(expected, Buffer.from(mac, 'hex'));
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === expected.size && actual.every(key => expected.has(key));
}

function validUuid(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function validHex64(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

async function readCanonicalRecord(file, secureFileOptions) {
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return Object.freeze({ state: 'absent' });
    return Object.freeze({ state: 'invalid', failure: 'unreadable' });
  }
  if (!stat.isFile()) return Object.freeze({ state: 'invalid', failure: 'not-regular' });
  const raw = await readOwnerOnlyFile(file, secureFileOptions).catch(() => null);
  if (!raw) return Object.freeze({ state: 'invalid', failure: 'unsafe-read' });
  if (raw.length > MAX_TRUST_RECORD_BYTES) {
    return Object.freeze({ state: 'invalid', failure: 'oversized' });
  }
  let value;
  const text = raw.toString('utf8');
  try {
    value = JSON.parse(text);
  } catch {
    return Object.freeze({ state: 'invalid', failure: 'malformed-json' });
  }
  if (text !== canonicalize(value)) {
    return Object.freeze({ state: 'invalid', failure: 'noncanonical' });
  }
  return Object.freeze({ state: 'present', raw, value });
}

async function readLegacyMachineKey(env, secureFileOptions) {
  const result = await readCanonicalKey(
    path.join(homeDir(env), 'machine-key'),
    secureFileOptions,
  );
  return result;
}

async function readCanonicalKey(file, secureFileOptions) {
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return Object.freeze({ state: 'absent' });
    return Object.freeze({ state: 'invalid', failure: 'key-unreadable' });
  }
  if (!stat.isFile()) return Object.freeze({ state: 'invalid', failure: 'key-not-regular' });
  const raw = await readOwnerOnlyFile(file, secureFileOptions).catch(() => null);
  if (!raw) return Object.freeze({ state: 'invalid', failure: 'key-unsafe-read' });
  const text = raw.toString('utf8');
  const material = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (!/^[0-9a-f]{64}$/.test(material) ||
      (text !== material && text !== `${material}\n`)) {
    return Object.freeze({ state: 'invalid', failure: 'key-noncanonical' });
  }
  return Object.freeze({ state: 'present', key: Buffer.from(material, 'hex') });
}

async function inventoryFormat1Slot({
  directory,
  env,
  keyResult,
  secureFileOptions,
  slot,
}) {
  const instance = await readCanonicalRecord(
    path.join(directory, 'instance.json'),
    secureFileOptions,
  );
  const record = await readCanonicalRecord(
    path.join(directory, `${slot}.json`),
    secureFileOptions,
  );
  if (record.state === 'absent') {
    return Object.freeze({ classification: 'absent', legacyFormats: Object.freeze([]) });
  }
  if (keyResult.state !== 'present' ||
      instance.state !== 'present' ||
      record.state !== 'present' ||
      !validMac(keyResult.key, instance.value) ||
      !validMac(keyResult.key, record.value) ||
      instance.value.ownerScope !== ownerScope(env) ||
      record.value.ownerScope !== ownerScope(env) ||
      record.value.projectIdentity !== instance.value.projectIdentity ||
      record.value.slot !== slot) {
    return Object.freeze({
      classification: 'invalid',
      legacyFormats: Object.freeze(['format-1']),
    });
  }
  return Object.freeze({
    classification: AUTHORITY_SLOTS.has(slot) ? 'eligible' : 'unsupported',
    legacyFormats: Object.freeze(['format-1']),
    recordDigest: `sha256:${sha256(record.raw)}`,
  });
}

async function readPhase4bBinding({
  canonicalRoot,
  env,
  keyResult,
  secureFileOptions,
}) {
  for (const directory of ['trust-v2-retired-phase4b', 'trust-v2']) {
    const storeRoot = path.join(homeDir(env), directory);
    const file = path.join(
      storeRoot,
      'bindings',
      `${sha256(canonicalRoot)}.json`,
    );
    const result = await readCanonicalRecord(file, secureFileOptions);
    if (result.state === 'absent') continue;
    if (result.state !== 'present') return result;
    const binding = result.value;
    if (binding?.domain === AUTH_DOMAINS.projectBinding &&
        directory === 'trust-v2') {
      continue;
    }
    if (keyResult.state !== 'present' ||
        !hasExactKeys(binding, PHASE4B_KEYS.binding) ||
        !phase4bMacValid(keyResult.key, 'project-binding', binding) ||
        binding.format !== 2 ||
        binding.type !== 'project-binding' ||
        !validUuid(binding.projectIdentity) ||
        binding.ownerScope !== ownerScope(env) ||
        binding.realpathHash !== sha256(canonicalRoot) ||
        binding.keyId !== sha256(keyResult.key)) {
      return Object.freeze({ state: 'invalid', failure: 'phase4b-binding-invalid' });
    }
    return Object.freeze({ state: 'present', value: binding, storeRoot });
  }
  return Object.freeze({ state: 'absent' });
}

async function inventoryPhase4bSlot({
  bindingResult,
  env,
  keyResult,
  secureFileOptions,
  slot,
}) {
  if (bindingResult.state === 'absent') {
    return Object.freeze({ classification: 'absent', legacyFormats: Object.freeze([]) });
  }
  if (bindingResult.state !== 'present' || keyResult.state !== 'present') {
    return Object.freeze({
      classification: 'invalid',
      legacyFormats: Object.freeze(['phase4b-format-2']),
    });
  }
  const binding = bindingResult.value;
  const projectDirectory = path.join(
    bindingResult.storeRoot,
    'projects',
    binding.projectIdentity,
  );
  const manifestResult = await readCanonicalRecord(
    path.join(projectDirectory, 'manifests', `${slot}.json`),
    secureFileOptions,
  );
  if (manifestResult.state === 'absent') {
    return Object.freeze({ classification: 'absent', legacyFormats: Object.freeze([]) });
  }
  const manifest = manifestResult.value;
  if (manifestResult.state !== 'present' ||
      !hasExactKeys(manifest, PHASE4B_KEYS.manifest) ||
      !phase4bMacValid(keyResult.key, 'manifest', manifest) ||
      manifest.format !== 2 ||
      manifest.type !== 'manifest' ||
      manifest.projectIdentity !== binding.projectIdentity ||
      manifest.ownerScope !== binding.ownerScope ||
      manifest.slot !== slot ||
      !Number.isInteger(manifest.currentGeneration) ||
      manifest.currentGeneration < 1 ||
      !validUuid(manifest.currentRecordId) ||
      !validHex64(manifest.currentRecordHash) ||
      !validUuid(manifest.auditHeadId) ||
      !validHex64(manifest.auditHeadHash) ||
      manifest.keyId !== binding.keyId) {
    return Object.freeze({
      classification: 'invalid',
      legacyFormats: Object.freeze(['phase4b-format-2']),
    });
  }

  let expectedGeneration = manifest.currentGeneration;
  let expectedRecordId = manifest.currentRecordId;
  let expectedRecordHash = manifest.currentRecordHash;
  let expectedAuditId = manifest.auditHeadId;
  let expectedAuditHash = manifest.auditHeadHash;
  const seen = new Set();
  while (expectedGeneration >= 1 && seen.size < manifest.currentGeneration) {
    if (seen.has(expectedAuditId)) break;
    seen.add(expectedAuditId);
    const recordResult = await readCanonicalRecord(
      path.join(
        projectDirectory,
        'records',
        slot,
        `${expectedGeneration}-${expectedAuditId}.json`,
      ),
      secureFileOptions,
    );
    const auditResult = await readCanonicalRecord(
      path.join(projectDirectory, 'audit', 'events', `${expectedAuditId}.json`),
      secureFileOptions,
    );
    const record = recordResult.value;
    const audit = auditResult.value;
    if (recordResult.state !== 'present' ||
        auditResult.state !== 'present' ||
        !hasExactKeys(record, PHASE4B_KEYS.record) ||
        !hasExactKeys(audit, PHASE4B_KEYS.audit) ||
        !phase4bMacValid(keyResult.key, 'slot-record', record) ||
        !phase4bMacValid(keyResult.key, 'audit-event', audit) ||
        sha256(recordResult.raw) !== expectedRecordHash ||
        sha256(auditResult.raw) !== expectedAuditHash ||
        record.recordId !== expectedRecordId ||
        record.projectIdentity !== binding.projectIdentity ||
        record.ownerScope !== binding.ownerScope ||
        record.slot !== slot ||
        record.generation !== expectedGeneration ||
        record.auditEventId !== expectedAuditId ||
        record.keyId !== binding.keyId ||
        audit.eventId !== expectedAuditId ||
        audit.projectIdentity !== binding.projectIdentity ||
        audit.ownerScope !== binding.ownerScope ||
        audit.slot !== slot ||
        audit.generation !== expectedGeneration ||
        audit.recordId !== expectedRecordId ||
        audit.recordHash !== expectedRecordHash ||
        audit.keyId !== binding.keyId) {
      return Object.freeze({
        classification: 'invalid',
        legacyFormats: Object.freeze(['phase4b-format-2']),
      });
    }
    if (expectedGeneration === 1) {
      if (record.previousRecordId !== null ||
          audit.previousGeneration !== 0 ||
          audit.previousRecordId !== null ||
          audit.previousAuditEventId !== null ||
          audit.previousAuditEventHash !== null) {
        break;
      }
      return Object.freeze({
        classification: 'eligible',
        legacyFormats: Object.freeze(['phase4b-format-2']),
        recordDigest: `sha256:${expectedRecordHash}`,
      });
    }
    if (audit.previousGeneration !== expectedGeneration - 1 ||
        record.previousRecordId !== audit.previousRecordId ||
        !validUuid(audit.previousRecordId) ||
        !validUuid(audit.previousAuditEventId) ||
        !validHex64(audit.previousAuditEventHash)) {
      break;
    }
    expectedGeneration -= 1;
    expectedRecordId = audit.previousRecordId;
    expectedAuditId = audit.previousAuditEventId;
    expectedAuditHash = audit.previousAuditEventHash;
    const predecessor = await readCanonicalRecord(
      path.join(
        projectDirectory,
        'records',
        slot,
        `${expectedGeneration}-${expectedAuditId}.json`,
      ),
      secureFileOptions,
    );
    expectedRecordHash = predecessor.state === 'present'
      ? sha256(predecessor.raw)
      : '';
  }
  return Object.freeze({
    classification: 'invalid',
    legacyFormats: Object.freeze(['phase4b-format-2']),
  });
}

export async function readLegacyTrustInventory({
  root,
  env = process.env,
  secureFileOptions = {},
}) {
  const canonicalRoot = await fs.realpath(root);
  const directory = path.join(homeDir(env), 'trust', sha256(canonicalRoot));
  const keyResult = await readLegacyMachineKey(env, secureFileOptions);
  const phase4bBinding = await readPhase4bBinding({
    canonicalRoot,
    env,
    keyResult,
    secureFileOptions,
  });
  const slots = {};
  for (const slot of LEGACY_SLOTS) {
    const format1 = await inventoryFormat1Slot({
      directory,
      env,
      keyResult,
      secureFileOptions,
      slot,
    });
    const phase4b = await inventoryPhase4bSlot({
      bindingResult: phase4bBinding,
      env,
      keyResult,
      secureFileOptions,
      slot,
    });
    const formats = [...format1.legacyFormats, ...phase4b.legacyFormats];
    if (format1.classification === 'invalid' || phase4b.classification === 'invalid') {
      slots[slot] = Object.freeze({
        classification: 'invalid',
        legacyFormats: Object.freeze(formats),
      });
    } else if (format1.classification === 'eligible' ||
               phase4b.classification === 'eligible') {
      slots[slot] = Object.freeze({
        classification: AUTHORITY_SLOTS.has(slot) ? 'eligible' : 'unsupported',
        legacyFormats: Object.freeze(formats),
        recordDigests: Object.freeze(
          [format1.recordDigest, phase4b.recordDigest].filter(Boolean),
        ),
      });
    } else {
      slots[slot] = Object.freeze({
        classification: format1.classification === 'unsupported'
          ? 'unsupported'
          : 'absent',
        legacyFormats: Object.freeze(formats),
      });
    }
  }
  return Object.freeze({
    schema: 'noosphere.legacy-trust-inventory',
    version: 1,
    projectRoot: canonicalRoot,
    phase4bProjectIdentity: phase4bBinding.state === 'present'
      ? phase4bBinding.value.projectIdentity
      : null,
    phase4bStore: phase4bBinding.state === 'present'
      ? path.basename(phase4bBinding.storeRoot)
      : null,
    slots: Object.freeze(slots),
  });
}
