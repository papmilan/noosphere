// SEC-05 Phase 4A-R1 — format-2 authority-state primitives (INTERNAL).
//
// This is the production-internal home of the Phase-4 trust state machine that
// previously lived only in the test harness. It ships inside the package
// (continuity/ is in package.json#files) so a future trusted in-process approval
// service (Phase 4B) can import it by relative path, but it is NOT reachable
// through package exports, supported deep imports, or any CLI/MCP/adapter — the
// export map lists only ./trust-store, and no shipped module imports these
// writers. It contains no interactive approval and mints no user-facing
// authority transition; it is the reusable substrate the tests exercise so the
// review's Blocker-1 (logic being test-only) is closed.
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  acquireOwnerOnlyLock,
  atomicOwnerOnlyWrite,
  ensureRealDirectoryPath,
  readOwnerOnlyFile,
  writeOwnerOnlyFileExclusive,
} from '../secure-fs.js';
import { NORM_ALGO, NORM_VERSION, normalizeUntrusted } from '../memory-safety.js';
import {
  MAX_TRUST_RECORD_BYTES,
  TrustStoreError,
  canonicalize,
  ensureMachineKey,
  homeDir,
  machineKeyId,
  ownerScope,
} from '../trust-store-internal.js';
import {
  AUTH_DOMAINS,
  authenticatedMac,
  verifyRecord,
} from './authenticated-records.js';
import {
  canonicalProjectIdentity,
  projectIdentityDigest,
} from './project-identity.js';
import { is, parseAuthenticatedRecord } from './strict-schema.js';
import {
  buildRevokedGeneration,
  validateTrustGeneration,
} from './trust-generation.js';

export const FORMAT = 2;
export const FORMAT2_SLOTS = Object.freeze(['master-prompt', 'instructions', 'baseline']);
export const JOURNAL_STATES = Object.freeze([
  'journal-prepared',
  'record-created',
  'audit-event-created',
  'manifest-committed',
]);

const SLOT_SET = new Set(FORMAT2_SLOTS);
const STATE_SET = new Set(JOURNAL_STATES);
const AUTHORITY_STATE_SET = new Set(['approved', 'revoked']);

function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function hmac(key, domain, fields) { return authenticatedMac(key, domain, fields); }
function equal(left, right) {
  const a = Buffer.from(String(left), 'utf8');
  const b = Buffer.from(String(right), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function bytes(value) { return Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8'); }
function contentHash(value) { return hash(Buffer.from(normalizeUntrusted(bytes(value).toString('utf8')), 'utf8')); }
function nowIso(now) { return (now ?? new Date()).toISOString(); }

// Exact per-record schemas (declared field => validator; unknown fields rejected).
const isSlot = is.enumOf(SLOT_SET);
const isFormat = is.intEquals(FORMAT);
const isNormAlgo = is.enumOf(new Set([NORM_ALGO]));
const isNormVersion = is.intEquals(NORM_VERSION);
const isProjectIdentityDigest = value =>
  typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);

const BINDING_SCHEMA = {
  domain: is.enumOf(new Set([AUTH_DOMAINS.projectBinding])),
  format: isFormat, type: is.enumOf(new Set(['project-binding'])),
  projectIdentity: is.uuid, ownerScope: is.str, realpathHash: is.hex64, keyId: is.hex64, mac: is.hex64,
};
const RECORD_SCHEMA = {
  domain: is.enumOf(new Set([AUTH_DOMAINS.approvedGeneration])),
  format: isFormat, type: is.enumOf(new Set(['slot-record'])),
  recordId: is.uuid, projectIdentity: is.uuid, projectIdentityDigest: isProjectIdentityDigest,
  ownerScope: is.str, slot: isSlot,
  generation: is.posInt, rawHash: is.hex64, contentHash: is.hex64,
  normAlgo: isNormAlgo, normVersion: isNormVersion, sourceOrigin: is.str,
  approvalEventId: is.uuid, previousRecordId: is.nullable(is.uuid), auditEventId: is.uuid,
  approvedAt: is.rfc3339utc, keyId: is.hex64, mac: is.hex64,
};
const REVOKED_RECORD_SCHEMA = {
  domain: is.enumOf(new Set([AUTH_DOMAINS.revokedGeneration])),
  schema: is.enumOf(new Set(['noosphere.sec05.revoked-generation'])),
  version: is.intEquals(1),
  recordId: is.uuid,
  projectIdentityDigest: isProjectIdentityDigest,
  ownerScope: is.str,
  slot: isSlot,
  generation: is.posInt,
  previousGeneration: is.nonNegInt,
  previousCurrentRecordId: is.uuid,
  previousCurrentRecordHash: is.hex64,
  transition: is.enumOf(new Set(['revoked'])),
  keyIdentity: is.hex64,
  auditEventId: is.uuid,
  createdAt: is.rfc3339utc,
  sourceOrigin: is.str,
  mac: is.hex64,
};
const MANIFEST_SCHEMA = {
  domain: is.enumOf(new Set([AUTH_DOMAINS.manifest])),
  format: isFormat, type: is.enumOf(new Set(['manifest'])),
  projectIdentity: is.uuid, projectIdentityDigest: isProjectIdentityDigest,
  ownerScope: is.str, slot: isSlot, currentGeneration: is.posInt,
  currentState: is.enumOf(AUTHORITY_STATE_SET),
  currentRecordId: is.uuid, currentRecordHash: is.hex64, auditHeadId: is.uuid, auditHeadHash: is.hex64,
  keyId: is.hex64, mac: is.hex64,
};
const AUDIT_SCHEMA = {
  domain: is.enumOf(new Set([AUTH_DOMAINS.audit])),
  format: isFormat, type: is.enumOf(new Set(['audit-event'])),
  eventId: is.uuid, eventType: is.str, projectIdentity: is.uuid,
  projectIdentityDigest: isProjectIdentityDigest, ownerScope: is.str, slot: isSlot,
  generation: is.posInt, recordId: is.uuid, recordHash: is.hex64,
  previousGeneration: is.nonNegInt, previousRecordId: is.nullable(is.uuid),
  previousAuditEventId: is.nullable(is.uuid), previousAuditEventHash: is.nullable(is.hex64),
  normAlgo: isNormAlgo, normVersion: isNormVersion, rawHash: is.hex64, contentHash: is.hex64,
  keyId: is.hex64, timestamp: is.rfc3339utc, mac: is.hex64,
};
const JOURNAL_SCHEMA = {
  domain: is.enumOf(new Set([AUTH_DOMAINS.authorityJournal])),
  format: isFormat, type: is.enumOf(new Set(['transaction-journal'])),
  transactionId: is.uuid, projectIdentity: is.uuid,
  projectIdentityDigest: isProjectIdentityDigest, ownerScope: is.str, slot: isSlot,
  candidateGeneration: is.posInt, priorManifestHash: is.nullable(is.hex64),
  recordId: is.uuid, auditEventId: is.uuid,
  recordHash: is.nullable(is.hex64), auditHash: is.nullable(is.hex64),
  state: is.enumOf(STATE_SET), keyId: is.hex64, mac: is.hex64,
};

function assertSlot(slot) { if (!SLOT_SET.has(slot)) throw new TrustStoreError('invalid-slot', `unsupported Phase 4A slot: ${slot}`); }

// Structural parse + MAC verification. Returns the parsed record or throws.
function verifyMac(key, type, domain, record) {
  if (!verifyRecord(key, domain, record)) {
    throw new TrustStoreError(`${type}-invalid`, `${type} MAC is invalid`);
  }
}

export function createFormatV2Store({ env = process.env, secureFileOptions = {}, now } = {}) {
  // Phase 4B: production callers (the approval service and the authority gate)
  // run without NOOSPHERE_HOME set, so fall back to the same default home the
  // rest of the trust store uses. This is a default, not a new selector: the
  // value still comes from homeDir(env), with no added precedence.
  const home = homeDir(env);
  const root = path.join(home, 'trust-v2');
  const options = { ...secureFileOptions, root: home };
  const key = () => ensureMachineKey(env, options);
  const scope = () => ownerScope(env);
  const identities = new Map();
  const rootFor = (binding) => path.join(root, 'projects', binding.projectIdentity);
  // The only binding key is the canonical realpath. Phase 4A deliberately permits
  // one active security principal per physical tree (Option A); repository
  // content and environment values therefore cannot select a second identity.
  // Phase 4B's owner-only identity-switch is the only intended way to replace it.
  const bindingPath = (projectRoot) => path.join(root, 'bindings', `${hash(fsSync.realpathSync(projectRoot))}.json`);
  const manifestPath = (binding, slot) => path.join(rootFor(binding), 'manifests', `${slot}.json`);
  const auditPath = (binding, eventId) => path.join(rootFor(binding), 'audit', 'events', `${eventId}.json`);
  const recordPath = (binding, slot, generation, eventId) => path.join(rootFor(binding), 'records', slot, `${generation}-${eventId}.json`);
  const journalPath = (binding, eventId) => path.join(rootFor(binding), 'transactions', `${eventId}.json`);
  const lockPath = (binding, slot) => path.join(rootFor(binding), 'locks', `${slot}.lock`);

  async function signed(domain, fields) {
    return { ...fields, mac: hmac(await key(), domain, fields) };
  }
  async function writeExclusive(file, value) { await ensureRealDirectoryPath(path.dirname(file)); await writeOwnerOnlyFileExclusive(file, canonicalize(value), options); }
  async function writeAtomic(file, value) { await ensureRealDirectoryPath(path.dirname(file)); await atomicOwnerOnlyWrite(file, canonicalize(value), options); }

  async function readParsed(file, type, schema) {
    const raw = await readOwnerOnlyFile(file, options);
    if (raw === null) return null;
    return parseAuthenticatedRecord(raw, { type, maxBytes: MAX_TRUST_RECORD_BYTES, schema });
  }

  async function createProjectBinding(projectRoot) {
    // The approval path deliberately leaves NOOSPHERE_HOME absent until the
    // owner confirms. Establish the owner-only root/key before the first secure
    // binding read so a genuine first approval can initialize format 2.
    const machineKey = await key();
    const file = bindingPath(projectRoot);
    if (await readOwnerOnlyFile(file, options) !== null) return readProjectBinding(projectRoot);
    const fields = {
      domain: AUTH_DOMAINS.projectBinding,
      format: FORMAT,
      type: 'project-binding',
      projectIdentity: crypto.randomUUID(),
      ownerScope: scope(),
      realpathHash: hash(await fs.realpath(projectRoot)),
      keyId: machineKeyId(machineKey),
    };
    const binding = {
      ...fields,
      mac: authenticatedMac(machineKey, AUTH_DOMAINS.projectBinding, fields),
    };
    try { await writeExclusive(file, binding); } catch (error) { if (error.code !== 'state-file-exists') throw error; }
    return readProjectBinding(projectRoot);
  }

  async function readProjectBinding(projectRoot) {
    const binding = await readParsed(bindingPath(projectRoot), 'project-binding', BINDING_SCHEMA);
    if (!binding) throw new TrustStoreError('binding-invalid', 'project binding is missing');
    verifyMac(await key(), 'project-binding', AUTH_DOMAINS.projectBinding, binding);
    if (binding.ownerScope !== scope()
      || !equal(binding.realpathHash, hash(await fs.realpath(projectRoot)))
      || !equal(binding.keyId, machineKeyId(await key()))) {
      throw new TrustStoreError('binding-invalid', 'project binding does not match this project/key');
    }
    const canonicalBindingBytes = await readOwnerOnlyFile(bindingPath(projectRoot), options);
    const identity = canonicalProjectIdentity({
      canonicalBindingBytes,
      canonicalRealpath: await fs.realpath(projectRoot),
      binding,
    });
    identities.set(binding.projectIdentity, identity);
    return binding;
  }

  async function readCanonicalProjectIdentity(projectRoot) {
    const binding = await readProjectBinding(projectRoot);
    return identities.get(binding.projectIdentity);
  }

  async function canonicalProjectIdentityDigest(projectRoot) {
    return projectIdentityDigest(await readCanonicalProjectIdentity(projectRoot));
  }

  function identityDigestFor(binding) {
    const identity = identities.get(binding.projectIdentity);
    if (!identity) {
      throw new TrustStoreError(
        'project-identity-invalid',
        'canonical project identity was not established from a verified binding',
      );
    }
    return projectIdentityDigest(identity);
  }

  async function readImmutableRecord(
    file,
    expectedState = 'approved',
    expectedIdentityDigest,
  ) {
    const revoked = expectedState === 'revoked';
    const type = revoked ? 'revoked-generation' : 'slot-record';
    const domain = revoked
      ? AUTH_DOMAINS.revokedGeneration
      : AUTH_DOMAINS.approvedGeneration;
    const schema = revoked ? REVOKED_RECORD_SCHEMA : RECORD_SCHEMA;
    const record = await readParsed(file, type, schema);
    if (!record) return null;
    verifyMac(await key(), type, domain, record);
    if (revoked) validateTrustGeneration(record);
    const canonicalDigest = expectedIdentityDigest ?? identityDigestFor(record);
    if (record.projectIdentityDigest !== canonicalDigest) {
      throw new TrustStoreError(
        'project-identity-invalid',
        'slot record does not match the canonical project identity',
      );
    }
    return record;
  }

  async function readManifest(binding, slot) {
    assertSlot(slot);
    const manifest = await readParsed(manifestPath(binding, slot), 'manifest', MANIFEST_SCHEMA);
    if (!manifest) return null;
    verifyMac(await key(), 'manifest', AUTH_DOMAINS.manifest, manifest);
    if (manifest.projectIdentity !== binding.projectIdentity
      || manifest.projectIdentityDigest !== identityDigestFor(binding)
      || manifest.ownerScope !== scope() || manifest.slot !== slot
      || !equal(manifest.keyId, machineKeyId(await key()))) {
      throw new TrustStoreError('manifest-invalid', 'manifest does not match binding');
    }
    return manifest;
  }

  async function readAudit(binding, eventId) {
    const event = await readParsed(auditPath(binding, eventId), 'audit-event', AUDIT_SCHEMA);
    if (!event) return null;
    verifyMac(await key(), 'audit-event', AUTH_DOMAINS.audit, event);
    if (event.projectIdentity !== binding.projectIdentity
      || event.projectIdentityDigest !== identityDigestFor(binding)
      || event.ownerScope !== scope()
      || !equal(event.keyId, machineKeyId(await key()))) {
      throw new TrustStoreError(
        'project-identity-invalid',
        'audit event does not match the canonical project identity',
      );
    }
    return event;
  }

  async function acquireLock(binding, slot, transactionId = crypto.randomUUID()) {
    assertSlot(slot);
    const fields = {
      domain: AUTH_DOMAINS.slotLock,
      format: FORMAT,
      type: 'trust-lock',
      token: transactionId,
      transactionId,
      projectIdentity: binding.projectIdentity,
      projectIdentityDigest: identityDigestFor(binding),
      ownerScope: scope(),
      slot,
      pid: process.pid,
      startedAt: nowIso(now),
      keyId: machineKeyId(await key()),
    };
    const metadata = await signed(AUTH_DOMAINS.slotLock, fields);
    const lock = await acquireOwnerOnlyLock(lockPath(binding, slot), { token: transactionId, metadata, ...options });
    return Object.freeze({ ...lock, transactionId });
  }

  // Authenticated lock inspection for recovery (SEC-05 review §8). The lock file
  // is `{...signedFields, mac, token}` written by JSON.stringify (so it is not
  // canonical and carries the raw token) — it does not go through the canonical
  // record parser. Returns the authenticated fields for a present, valid lock,
  // null when absent, and throws a distinct fail-closed error for malformed /
  // unauthenticated / foreign locks. There is NO automatic reclamation: any
  // authenticated live lock is owner-intervention territory, and dead-PID / reuse
  // / reboot are deliberately not auto-distinguished.
  async function inspectLock(binding, slot) {
    assertSlot(slot);
    const lockFile = lockPath(binding, slot);
    // readOwnerOnlyFile returns null both for a genuinely absent file AND for a
    // containment/reparse-rejected path, so an unsafe lock (e.g. a symlink) must
    // NOT be read as "no lock" — that would let recovery proceed fail-open. lstat
    // distinguishes ENOENT (truly absent → null) from present-but-unsafe (throw).
    let stat;
    try { stat = await fs.lstat(lockFile); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile()) throw new TrustStoreError('trust-lock-unreadable', 'lock path is not a regular file');
    const raw = await readOwnerOnlyFile(lockFile, options);
    if (raw === null) throw new TrustStoreError('trust-lock-unreadable', 'lock is present but could not be securely read');
    let parsed;
    try { parsed = JSON.parse(raw.toString('utf8')); } catch { throw new TrustStoreError('trust-lock-malformed', 'lock metadata is not JSON'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TrustStoreError('trust-lock-malformed', 'lock metadata is not an object');
    if (!is.uuid(parsed.token) || !is.hex64(parsed.mac)) throw new TrustStoreError('trust-lock-malformed', 'lock token or MAC is malformed');
    if (parsed.domain !== AUTH_DOMAINS.slotLock || parsed.type !== 'trust-lock'
      || parsed.format !== FORMAT || !is.uuid(parsed.transactionId)
      || !is.uuid(parsed.projectIdentity) || !isProjectIdentityDigest(parsed.projectIdentityDigest)
      || !is.hex64(parsed.keyId)) {
      throw new TrustStoreError('trust-lock-malformed', 'lock fields are malformed');
    }
    if (!verifyRecord(await key(), AUTH_DOMAINS.slotLock, parsed)) throw new TrustStoreError('trust-lock-unauthenticated', 'lock MAC does not verify');
    if (parsed.transactionId !== parsed.token
      || parsed.projectIdentity !== binding.projectIdentity
      || parsed.projectIdentityDigest !== identityDigestFor(binding)
      || parsed.ownerScope !== scope() || parsed.slot !== slot
      || !equal(parsed.keyId, machineKeyId(await key()))) {
      throw new TrustStoreError('trust-lock-foreign', 'lock belongs to another project, owner, key, or slot');
    }
    return parsed;
  }

  // Complete structural chain validation (SEC-05 review §6). Walks head→genesis
  // asserting per-link generation decrement, predecessor record-id linkage, and
  // predecessor file-hash linkage; pins genesis to generation 1 with all
  // predecessor fields null; bounds iteration and rejects cycles via a seen-set.
  // No attacker-selected early termination is accepted.
  async function verifyAuditChain(binding, slot) {
    try {
      const manifest = await readManifest(binding, slot); if (!manifest) return false;
      let id = manifest.auditHeadId;
      let expectedHash = manifest.auditHeadHash;
      let expectedGeneration = manifest.currentGeneration;
      let expectedRecordId = manifest.currentRecordId;
      const seen = new Set();
      for (;;) {
        if (seen.has(id) || seen.size >= manifest.currentGeneration) return false; // cycle / bound
        seen.add(id);
        const event = await readAudit(binding, id); if (!event) return false;
        if (event.slot !== slot || event.projectIdentity !== binding.projectIdentity || event.ownerScope !== scope()) return false;
        if (event.generation !== expectedGeneration || event.recordId !== expectedRecordId) return false;
        const raw = await readOwnerOnlyFile(auditPath(binding, id), options);
        if (!raw || !equal(hash(raw), expectedHash)) return false;
        if (event.previousAuditEventId === null) {
          return expectedGeneration === 1 && event.previousGeneration === 0 && event.previousRecordId === null && event.previousAuditEventHash === null;
        }
        if (event.previousGeneration !== expectedGeneration - 1 || event.previousAuditEventHash === null || event.previousRecordId === null) return false;
        id = event.previousAuditEventId;
        expectedHash = event.previousAuditEventHash;
        expectedRecordId = event.previousRecordId;
        expectedGeneration -= 1;
        if (expectedGeneration < 1) return false;
      }
    } catch { return false; }
  }

  async function readSlotRecordSequence(binding, slot) {
    const directory = path.join(rootFor(binding), 'records', slot);
    const entries = await fs.readdir(directory).catch(error =>
      error.code === 'ENOENT' ? [] : Promise.reject(error));
    const counts = new Map();
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const match = /^([1-9]\d*)-([0-9a-f-]{36})\.json$/.exec(entry);
      if (!match || !is.uuid(match[2])) {
        throw new TrustStoreError(
          'authority-history-invalid',
          'generation filename is invalid',
        );
      }
      const generation = Number(match[1]);
      counts.set(generation, (counts.get(generation) ?? 0) + 1);
    }
    return counts;
  }

  async function validateSlotRecordSequence(binding, slot, manifest) {
    const counts = await readSlotRecordSequence(binding, slot);
    if (!manifest) {
      if (counts.size !== 0) {
        throw new TrustStoreError(
          'authority-history-invalid',
          'generation history exists without a manifest',
        );
      }
      return;
    }
    if (counts.size !== manifest.currentGeneration) {
      throw new TrustStoreError(
        'authority-history-invalid',
        'generation history length does not match the manifest',
      );
    }
    for (let generation = 1; generation <= manifest.currentGeneration; generation += 1) {
      if (counts.get(generation) !== 1) {
        throw new TrustStoreError(
          'authority-history-invalid',
          'generation history has a gap, duplicate, or rollback',
        );
      }
    }
  }

  async function isFormat2Authoritative({ binding, slot, rawBytes }) {
    try {
      const manifest = await readManifest(binding, slot);
      if (!manifest) return false;
      await validateSlotRecordSequence(binding, slot, manifest);
      if (!await verifyAuditChain(binding, slot)) return false;
      if (manifest.currentState !== 'approved') return false;
      const event = await readAudit(binding, manifest.auditHeadId); if (!event) return false;
      const file = recordPath(binding, slot, manifest.currentGeneration, event.eventId);
      const record = await readImmutableRecord(
        file,
        'approved',
        identityDigestFor(binding),
      );
      if (!record) return false;
      const raw = await readOwnerOnlyFile(file, options);
      const value = bytes(rawBytes);
      return record.recordId === manifest.currentRecordId
        && equal(hash(raw), manifest.currentRecordHash)
        && record.auditEventId === event.eventId
        && event.recordId === record.recordId
        && equal(event.recordHash, manifest.currentRecordHash)
        && record.generation === manifest.currentGeneration
        && record.projectIdentity === binding.projectIdentity
        && record.ownerScope === scope()
        && record.slot === slot
        && equal(record.keyId, manifest.keyId)
        && record.normAlgo === NORM_ALGO
        && record.normVersion === NORM_VERSION
        && equal(record.rawHash, hash(value))
        && equal(record.contentHash, contentHash(value));
    } catch { return false; }
  }

  async function writeJournal(binding, eventId, fields) {
    return writeAtomic(
      journalPath(binding, eventId),
      await signed(AUTH_DOMAINS.authorityJournal, fields),
    );
  }

  // Serialized immutable commit. `onStep(state)` is an optional observation-only
  // seam (default no-op) used by crash tests to inject termination at a durable
  // boundary; it can never mint authority and is undefined in production callers.
  // ponytail: exception-injection crash tests use this seam in R1; R2 replaces
  // them with child-process SIGKILL and this seam becomes the kill point.
  async function commitTransaction({ binding, slot, rawBytes, sourceOrigin, onStep = () => {} } = {}) {
    assertSlot(slot);
    if (typeof sourceOrigin !== 'string' || sourceOrigin.length === 0) throw new TrustStoreError('record-invalid', 'sourceOrigin is required');
    const eventId = crypto.randomUUID();
    const lock = await acquireLock(binding, slot, eventId);
    try {
      const prior = await readManifest(binding, slot);
      const generation = (prior?.currentGeneration ?? 0) + 1;
      const value = bytes(rawBytes);
      const machineKey = await key();
      const keyId = machineKeyId(machineKey);
      const projectIdentityDigest = identityDigestFor(binding);
      const recordId = crypto.randomUUID();
      const approvedAt = nowIso(now);
      const priorManifestHash = prior ? hash(await readOwnerOnlyFile(manifestPath(binding, slot), options)) : null;
      const journal = {
        domain: AUTH_DOMAINS.authorityJournal,
        format: FORMAT,
        type: 'transaction-journal',
        transactionId: eventId,
        projectIdentity: binding.projectIdentity,
        projectIdentityDigest,
        ownerScope: scope(),
        slot,
        candidateGeneration: generation,
        priorManifestHash,
        recordId,
        auditEventId: eventId,
        recordHash: null,
        auditHash: null,
        state: 'journal-prepared',
        keyId,
      };
      await writeJournal(binding, eventId, journal);
      await onStep('journal-prepared');

      const recordFields = {
        domain: AUTH_DOMAINS.approvedGeneration,
        format: FORMAT,
        type: 'slot-record',
        recordId,
        projectIdentity: binding.projectIdentity,
        projectIdentityDigest,
        ownerScope: scope(),
        slot,
        generation,
        rawHash: hash(value),
        contentHash: contentHash(value),
        normAlgo: NORM_ALGO,
        normVersion: NORM_VERSION,
        sourceOrigin,
        approvalEventId: eventId,
        previousRecordId: prior?.currentRecordId ?? null,
        auditEventId: eventId,
        approvedAt,
        keyId,
      };
      const record = {
        ...recordFields,
        mac: hmac(machineKey, AUTH_DOMAINS.approvedGeneration, recordFields),
      };
      const recordFile = recordPath(binding, slot, generation, eventId);
      await writeExclusive(recordFile, record);
      const recordHash = hash(await readOwnerOnlyFile(recordFile, options));
      await writeJournal(binding, eventId, { ...journal, recordHash, state: 'record-created' });
      await onStep('record-created');

      const auditFields = {
        domain: AUTH_DOMAINS.audit,
        format: FORMAT,
        type: 'audit-event',
        eventId,
        eventType: 'phase4a',
        projectIdentity: binding.projectIdentity,
        projectIdentityDigest,
        ownerScope: scope(),
        slot,
        generation,
        recordId,
        recordHash,
        previousGeneration: prior?.currentGeneration ?? 0,
        previousRecordId: prior?.currentRecordId ?? null,
        previousAuditEventId: prior?.auditHeadId ?? null,
        previousAuditEventHash: prior?.auditHeadHash ?? null,
        normAlgo: NORM_ALGO,
        normVersion: NORM_VERSION,
        rawHash: record.rawHash,
        contentHash: record.contentHash,
        keyId,
        timestamp: approvedAt,
      };
      const audit = {
        ...auditFields,
        mac: hmac(machineKey, AUTH_DOMAINS.audit, auditFields),
      };
      const eventFile = auditPath(binding, eventId);
      await writeExclusive(eventFile, audit);
      const auditHash = hash(await readOwnerOnlyFile(eventFile, options));
      await writeJournal(binding, eventId, { ...journal, recordHash, auditHash, state: 'audit-event-created' });
      await onStep('audit-event-created');

      // Serialize check-and-set under the held lock: the manifest must be exactly
      // what we read at the start, or another writer changed it and we abort.
      const current = await readManifest(binding, slot);
      if ((current?.currentGeneration ?? 0) !== (prior?.currentGeneration ?? 0)
        || (prior && hash(await readOwnerOnlyFile(manifestPath(binding, slot), options)) !== priorManifestHash)) {
        throw new TrustStoreError('manifest-cas-mismatch', 'manifest changed during transaction');
      }
      const manifestFields = {
        domain: AUTH_DOMAINS.manifest,
        format: FORMAT,
        type: 'manifest',
        projectIdentity: binding.projectIdentity,
        projectIdentityDigest,
        ownerScope: scope(),
        slot,
        currentGeneration: generation,
        currentState: 'approved',
        currentRecordId: recordId,
        currentRecordHash: recordHash,
        auditHeadId: eventId,
        auditHeadHash: auditHash,
        keyId,
      };
      const manifest = {
        ...manifestFields,
        mac: hmac(machineKey, AUTH_DOMAINS.manifest, manifestFields),
      };
      await writeAtomic(manifestPath(binding, slot), manifest);
      await writeJournal(binding, eventId, { ...journal, recordHash, auditHash, state: 'manifest-committed' });
      await onStep('manifest-committed');

      if (!await isFormat2Authoritative({ binding, slot, rawBytes: value })) throw new TrustStoreError('commit-verification-failed', 'committed manifest did not verify');
      await fs.rm(journalPath(binding, eventId), { force: true });
      return { record, audit, manifest };
    } finally {
      await lock.release().catch(() => undefined);
    }
  }

  async function classifySlot({ binding, slot }) {
    assertSlot(slot);
    const manifest = await readManifest(binding, slot);
    if (!manifest) {
      await validateSlotRecordSequence(binding, slot, null);
      return Object.freeze({
        state: 'pristine-unapproved',
        generation: 0,
        recordId: null,
        recordHash: null,
      });
    }
    await validateSlotRecordSequence(binding, slot, manifest);
    if (!await verifyAuditChain(binding, slot)) {
      throw new TrustStoreError('authority-history-invalid', 'authority audit chain is invalid');
    }
    const event = await readAudit(binding, manifest.auditHeadId);
    if (!event) {
      throw new TrustStoreError('authority-history-invalid', 'current audit event is missing');
    }
    const file = recordPath(
      binding,
      slot,
      manifest.currentGeneration,
      event.eventId,
    );
    const generation = await readImmutableRecord(
      file,
      manifest.currentState,
      identityDigestFor(binding),
    );
    const raw = await readOwnerOnlyFile(file, options);
    if (!generation || !raw ||
        generation.recordId !== manifest.currentRecordId ||
        hash(raw) !== manifest.currentRecordHash ||
        event.recordId !== manifest.currentRecordId ||
        event.recordHash !== manifest.currentRecordHash) {
      throw new TrustStoreError('authority-history-invalid', 'current generation is invalid');
    }
    return Object.freeze({
      state: manifest.currentState,
      generation: manifest.currentGeneration,
      recordId: manifest.currentRecordId,
      recordHash: manifest.currentRecordHash,
      generationRecord: generation,
      manifest,
    });
  }

  async function commitApproval(input = {}) {
    const result = await commitTransaction(input);
    return Object.freeze({
      ...result,
      status: 'approved',
      generation: result.record,
    });
  }

  async function commitRevocation({
    binding,
    slot,
    sourceOrigin,
    onStep = () => {},
  } = {}) {
    assertSlot(slot);
    if (sourceOrigin !== `cli:trust-revoke:${slot}`) {
      throw new TrustStoreError(
        'revoked-generation-invalid',
        'revocation source origin is invalid',
      );
    }
    const eventId = crypto.randomUUID();
    const lock = await acquireLock(binding, slot, eventId);
    try {
      const prior = await readManifest(binding, slot);
      if (!prior) {
        throw new TrustStoreError(
          'revocation-no-approved-generation',
          'revocation requires an approved current generation',
        );
      }
      if (prior.currentState === 'revoked') {
        const current = await classifySlot({ binding, slot });
        return Object.freeze({
          status: 'already-revoked',
          generation: current.generationRecord,
          manifest: current.manifest,
        });
      }
      if (prior.currentState !== 'approved' ||
          !await verifyAuditChain(binding, slot)) {
        throw new TrustStoreError(
          'authority-history-invalid',
          'revocation requires valid approved history',
        );
      }
      const priorAudit = await readAudit(binding, prior.auditHeadId);
      const priorRecordFile = recordPath(
        binding,
        slot,
        prior.currentGeneration,
        priorAudit.eventId,
      );
      const priorRecord = await readImmutableRecord(
        priorRecordFile,
        'approved',
        identityDigestFor(binding),
      );
      const priorRecordRaw = await readOwnerOnlyFile(priorRecordFile, options);
      if (!priorRecord || !priorRecordRaw ||
          hash(priorRecordRaw) !== prior.currentRecordHash) {
        throw new TrustStoreError(
          'authority-history-invalid',
          'current approved generation is invalid',
        );
      }

      const generation = prior.currentGeneration + 1;
      const machineKey = await key();
      const keyId = machineKeyId(machineKey);
      const projectIdentityDigest = identityDigestFor(binding);
      const recordId = crypto.randomUUID();
      const createdAt = nowIso(now);
      const priorManifestHash = hash(
        await readOwnerOnlyFile(manifestPath(binding, slot), options),
      );
      const journal = {
        domain: AUTH_DOMAINS.authorityJournal,
        format: FORMAT,
        type: 'transaction-journal',
        transactionId: eventId,
        projectIdentity: binding.projectIdentity,
        projectIdentityDigest,
        ownerScope: scope(),
        slot,
        candidateGeneration: generation,
        priorManifestHash,
        recordId,
        auditEventId: eventId,
        recordHash: null,
        auditHash: null,
        state: 'journal-prepared',
        keyId,
      };
      await writeJournal(binding, eventId, journal);
      await onStep('journal-prepared');

      const tombstoneFields = buildRevokedGeneration({
        recordId,
        projectIdentityDigest,
        ownerScope: scope(),
        slot,
        generation,
        previousGeneration: prior.currentGeneration,
        previousCurrentRecordId: prior.currentRecordId,
        previousCurrentRecordHash: prior.currentRecordHash,
        keyIdentity: keyId,
        auditEventId: eventId,
        createdAt,
        sourceOrigin,
      });
      const tombstone = {
        ...tombstoneFields,
        mac: hmac(machineKey, AUTH_DOMAINS.revokedGeneration, tombstoneFields),
      };
      validateTrustGeneration(tombstone);
      const generationFile = recordPath(binding, slot, generation, eventId);
      await writeExclusive(generationFile, tombstone);
      const recordHash = hash(
        await readOwnerOnlyFile(generationFile, options),
      );
      await writeJournal(binding, eventId, {
        ...journal,
        recordHash,
        state: 'record-created',
      });
      await onStep('record-created');

      const auditFields = {
        domain: AUTH_DOMAINS.audit,
        format: FORMAT,
        type: 'audit-event',
        eventId,
        eventType: 'revoked',
        projectIdentity: binding.projectIdentity,
        projectIdentityDigest,
        ownerScope: scope(),
        slot,
        generation,
        recordId,
        recordHash,
        previousGeneration: prior.currentGeneration,
        previousRecordId: prior.currentRecordId,
        previousAuditEventId: prior.auditHeadId,
        previousAuditEventHash: prior.auditHeadHash,
        normAlgo: priorRecord.normAlgo,
        normVersion: priorRecord.normVersion,
        rawHash: priorRecord.rawHash,
        contentHash: priorRecord.contentHash,
        keyId,
        timestamp: createdAt,
      };
      const audit = {
        ...auditFields,
        mac: hmac(machineKey, AUTH_DOMAINS.audit, auditFields),
      };
      const auditFile = auditPath(binding, eventId);
      await writeExclusive(auditFile, audit);
      const auditHash = hash(await readOwnerOnlyFile(auditFile, options));
      await writeJournal(binding, eventId, {
        ...journal,
        recordHash,
        auditHash,
        state: 'audit-event-created',
      });
      await onStep('audit-event-created');

      const current = await readManifest(binding, slot);
      if (!current ||
          current.currentGeneration !== prior.currentGeneration ||
          current.currentState !== 'approved' ||
          hash(await readOwnerOnlyFile(manifestPath(binding, slot), options)) !==
            priorManifestHash) {
        throw new TrustStoreError(
          'manifest-cas-mismatch',
          'manifest changed during revocation',
        );
      }
      const manifestFields = {
        domain: AUTH_DOMAINS.manifest,
        format: FORMAT,
        type: 'manifest',
        projectIdentity: binding.projectIdentity,
        projectIdentityDigest,
        ownerScope: scope(),
        slot,
        currentGeneration: generation,
        currentState: 'revoked',
        currentRecordId: recordId,
        currentRecordHash: recordHash,
        auditHeadId: eventId,
        auditHeadHash: auditHash,
        keyId,
      };
      const manifest = {
        ...manifestFields,
        mac: hmac(machineKey, AUTH_DOMAINS.manifest, manifestFields),
      };
      await writeAtomic(manifestPath(binding, slot), manifest);
      await writeJournal(binding, eventId, {
        ...journal,
        recordHash,
        auditHash,
        state: 'manifest-committed',
      });
      await onStep('manifest-committed');

      const classified = await classifySlot({ binding, slot });
      if (classified.state !== 'revoked' ||
          classified.generation !== generation) {
        throw new TrustStoreError(
          'commit-verification-failed',
          'committed revocation did not verify',
        );
      }
      await fs.rm(journalPath(binding, eventId), { force: true });
      return Object.freeze({
        status: 'revoked',
        generation: tombstone,
        audit,
        manifest,
      });
    } finally {
      await lock.release().catch(() => undefined);
    }
  }

  async function quarantine(file) { await fs.rename(file, `${file}.quarantine`).catch(() => undefined); }

  async function quarantineIncompleteArtifacts(binding, slot, journal) {
    if (journal.state === 'record-created' ||
        journal.state === 'audit-event-created') {
      await quarantine(recordPath(
        binding,
        slot,
        journal.candidateGeneration,
        journal.auditEventId,
      ));
    }
    if (journal.state === 'audit-event-created') {
      await quarantine(auditPath(binding, journal.auditEventId));
    }
  }

  // Decide the recovery disposition of one journal WITHOUT ever synthesizing or
  // repairing a manifest. Returns 'delete' (safe cleanup), 'quarantine'
  // (tampered / referenced hash mismatch), or 'ambiguous' (a committed journal
  // whose manifest we cannot corroborate — fail closed).
  async function journalDisposition(binding, slot, journal) {
    const manifest = await readManifest(binding, slot).catch(() => null);
    const manifestGen = manifest?.currentGeneration ?? 0;
    if (journal.state === 'manifest-committed') {
      if (manifest && manifestGen === journal.candidateGeneration) return manifest.currentRecordId === journal.recordId ? 'delete' : 'ambiguous';
      if (manifest && manifestGen > journal.candidateGeneration) return 'delete'; // superseded by a newer commit
      return 'ambiguous'; // claims committed but manifest is absent or behind
    }
    // Incomplete states: re-verify the referenced artifacts' hashes before
    // discarding the (inert) orphans. A mismatch means tampering → quarantine.
    if (journal.state === 'record-created' || journal.state === 'audit-event-created') {
      const file = recordPath(
        binding,
        slot,
        journal.candidateGeneration,
        journal.auditEventId,
      );
      const recRaw = await readOwnerOnlyFile(file, options).catch(() => null);
      if (!recRaw || !journal.recordHash || !equal(hash(recRaw), journal.recordHash)) return 'quarantine';
      let candidate;
      try {
        candidate = JSON.parse(recRaw.toString('utf8'));
        const state = candidate.domain === AUTH_DOMAINS.revokedGeneration
          ? 'revoked'
          : 'approved';
        await readImmutableRecord(
          file,
          state,
          identityDigestFor(binding),
        );
      } catch {
        return 'quarantine';
      }
    }
    if (journal.state === 'audit-event-created') {
      const evtRaw = await readOwnerOnlyFile(auditPath(binding, journal.auditEventId), options).catch(() => null);
      if (!evtRaw || !journal.auditHash || !equal(hash(evtRaw), journal.auditHash)) return 'quarantine';
      try {
        await readAudit(binding, journal.auditEventId);
      } catch {
        return 'quarantine';
      }
    }
    return 'delete';
  }

  // Fail-closed recovery. A present lock is owner-intervention territory (no
  // automatic reclamation — SEC-05 review §8). Every journal is fully schema- and
  // MAC-verified and its referenced hashes checked before any deletion; a valid
  // journal for an already-superseded generation is cleaned up, a tampered one is
  // quarantined, and a committed journal we cannot corroborate is fatal.
  async function recover(binding, slot) {
    assertSlot(slot);
    // Authenticate any present lock; a valid live lock (or a malformed / foreign /
    // unreadable one) is fail-closed owner-intervention territory — recovery never
    // reclaims it.
    if (await inspectLock(binding, slot) !== null) throw new TrustStoreError('trust-lock-live', 'an authenticated transaction lock is held; owner action required');
    // Hold the slot lock while mutating journals so recovery cannot run
    // concurrently with an in-flight commit: a commit that raced in after the
    // inspectLock check makes this acquire throw trust-lock-busy (fail-closed).
    const lock = await acquireLock(binding, slot);
    try {
      const dir = path.join(rootFor(binding), 'transactions');
      const entries = await fs.readdir(dir).catch((error) => (error.code === 'ENOENT' ? [] : Promise.reject(error)));
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const file = path.join(dir, entry);
        let journal;
        try {
          const raw = await readOwnerOnlyFile(file, options);
          if (raw === null) continue;
          journal = parseAuthenticatedRecord(raw, { type: 'transaction-journal', maxBytes: MAX_TRUST_RECORD_BYTES, schema: JOURNAL_SCHEMA });
          verifyMac(
            await key(),
            'transaction-journal',
            AUTH_DOMAINS.authorityJournal,
            journal,
          );
        } catch { await quarantine(file); continue; }
        if (journal.projectIdentity !== binding.projectIdentity
          || journal.projectIdentityDigest !== identityDigestFor(binding)
          || journal.slot !== slot) {
          await quarantine(file);
          continue;
        }
        const disposition = await journalDisposition(binding, slot, journal);
        if (disposition === 'ambiguous') throw new TrustStoreError('recovery-ambiguous', 'committed journal does not match manifest');
        if (disposition === 'quarantine') {
          await quarantineIncompleteArtifacts(binding, slot, journal);
          await quarantine(file);
          continue;
        }
        if (journal.state !== 'manifest-committed') {
          await quarantineIncompleteArtifacts(binding, slot, journal);
        }
        await fs.rm(file, { force: true });
      }
    } finally {
      await lock.release().catch(() => undefined);
    }
  }

  return Object.freeze({
    createProjectBinding, readProjectBinding, readCanonicalProjectIdentity,
    canonicalProjectIdentityDigest, readImmutableRecord, readManifest, readAudit,
    acquireLock, inspectLock, verifyAuditChain, isFormat2Authoritative,
    classifySlot, commitApproval, commitRevocation, commitTransaction, recover,
    ensureMachineKey: key,
    bindingPath, manifestPath, auditPath, recordPath, journalPath, lockPath,
    pathFor: (binding, relative) => path.join(rootFor(binding), relative),
    // Low-level helpers reused by the test-only harness to seed adversarial state.
    _internal: Object.freeze({
      signed,
      writeExclusive,
      hmac,
      hash,
      contentHash,
      machineKeyId,
      scope,
      identityDigestFor,
      nowIso: () => nowIso(now),
    }),
  });
}
