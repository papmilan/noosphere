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
import { is, parseAuthenticatedRecord } from './strict-schema.js';

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

function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function hmac(key, type, fields) {
  return crypto.createHmac('sha256', key).update(`noosphere/sec05/v2/${type}\0${canonicalize(fields)}`).digest('hex');
}
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

const BINDING_SCHEMA = {
  format: isFormat, type: is.enumOf(new Set(['project-binding'])),
  projectIdentity: is.uuid, ownerScope: is.str, realpathHash: is.hex64, keyId: is.hex64, mac: is.hex64,
};
const RECORD_SCHEMA = {
  format: isFormat, type: is.enumOf(new Set(['slot-record'])),
  recordId: is.uuid, projectIdentity: is.uuid, ownerScope: is.str, slot: isSlot,
  generation: is.posInt, rawHash: is.hex64, contentHash: is.hex64,
  normAlgo: isNormAlgo, normVersion: isNormVersion, sourceOrigin: is.str,
  approvalEventId: is.uuid, previousRecordId: is.nullable(is.uuid), auditEventId: is.uuid,
  approvedAt: is.rfc3339utc, keyId: is.hex64, mac: is.hex64,
};
const MANIFEST_SCHEMA = {
  format: isFormat, type: is.enumOf(new Set(['manifest'])),
  projectIdentity: is.uuid, ownerScope: is.str, slot: isSlot, currentGeneration: is.posInt,
  currentRecordId: is.uuid, currentRecordHash: is.hex64, auditHeadId: is.uuid, auditHeadHash: is.hex64,
  keyId: is.hex64, mac: is.hex64,
};
const AUDIT_SCHEMA = {
  format: isFormat, type: is.enumOf(new Set(['audit-event'])),
  eventId: is.uuid, eventType: is.str, projectIdentity: is.uuid, ownerScope: is.str, slot: isSlot,
  generation: is.posInt, recordId: is.uuid, recordHash: is.hex64,
  previousGeneration: is.nonNegInt, previousRecordId: is.nullable(is.uuid),
  previousAuditEventId: is.nullable(is.uuid), previousAuditEventHash: is.nullable(is.hex64),
  normAlgo: isNormAlgo, normVersion: isNormVersion, rawHash: is.hex64, contentHash: is.hex64,
  keyId: is.hex64, timestamp: is.rfc3339utc, mac: is.hex64,
};
const JOURNAL_SCHEMA = {
  format: isFormat, type: is.enumOf(new Set(['transaction-journal'])),
  transactionId: is.uuid, projectIdentity: is.uuid, ownerScope: is.str, slot: isSlot,
  candidateGeneration: is.posInt, priorManifestHash: is.nullable(is.hex64),
  recordId: is.uuid, auditEventId: is.uuid,
  recordHash: is.nullable(is.hex64), auditHash: is.nullable(is.hex64),
  state: is.enumOf(STATE_SET), keyId: is.hex64, mac: is.hex64,
};

function assertSlot(slot) { if (!SLOT_SET.has(slot)) throw new TrustStoreError('invalid-slot', `unsupported Phase 4A slot: ${slot}`); }

// Structural parse + MAC verification. Returns the parsed record or throws.
function verifyMac(key, type, record) {
  const { mac, ...fields } = record;
  if (!equal(hmac(key, type, fields), mac)) throw new TrustStoreError(`${type}-invalid`, `${type} MAC is invalid`);
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

  async function signed(type, fields) { return { ...fields, mac: hmac(await key(), type, fields) }; }
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
    const fields = { format: FORMAT, type: 'project-binding', projectIdentity: crypto.randomUUID(), ownerScope: scope(), realpathHash: hash(await fs.realpath(projectRoot)), keyId: machineKeyId(machineKey) };
    const binding = { ...fields, mac: hmac(machineKey, 'project-binding', fields) };
    try { await writeExclusive(file, binding); } catch (error) { if (error.code !== 'state-file-exists') throw error; }
    return readProjectBinding(projectRoot);
  }

  async function readProjectBinding(projectRoot) {
    const binding = await readParsed(bindingPath(projectRoot), 'project-binding', BINDING_SCHEMA);
    if (!binding) throw new TrustStoreError('binding-invalid', 'project binding is missing');
    verifyMac(await key(), 'project-binding', binding);
    if (binding.ownerScope !== scope()
      || !equal(binding.realpathHash, hash(await fs.realpath(projectRoot)))
      || !equal(binding.keyId, machineKeyId(await key()))) {
      throw new TrustStoreError('binding-invalid', 'project binding does not match this project/key');
    }
    return binding;
  }

  async function readImmutableRecord(file) {
    const record = await readParsed(file, 'slot-record', RECORD_SCHEMA);
    if (!record) return null;
    verifyMac(await key(), 'slot-record', record);
    return record;
  }

  async function readManifest(binding, slot) {
    assertSlot(slot);
    const manifest = await readParsed(manifestPath(binding, slot), 'manifest', MANIFEST_SCHEMA);
    if (!manifest) return null;
    verifyMac(await key(), 'manifest', manifest);
    if (manifest.projectIdentity !== binding.projectIdentity || manifest.ownerScope !== scope() || manifest.slot !== slot || !equal(manifest.keyId, machineKeyId(await key()))) {
      throw new TrustStoreError('manifest-invalid', 'manifest does not match binding');
    }
    return manifest;
  }

  async function readAudit(binding, eventId) {
    const event = await readParsed(auditPath(binding, eventId), 'audit-event', AUDIT_SCHEMA);
    if (!event) return null;
    verifyMac(await key(), 'audit-event', event);
    return event;
  }

  async function acquireLock(binding, slot, transactionId = crypto.randomUUID()) {
    assertSlot(slot);
    const fields = { format: FORMAT, type: 'trust-lock', transactionId, projectIdentity: binding.projectIdentity, ownerScope: scope(), slot, pid: process.pid, startedAt: nowIso(now), keyId: machineKeyId(await key()) };
    const metadata = await signed('trust-lock', fields);
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
    const { token, mac, ...fields } = parsed;
    if (!is.uuid(token) || !is.hex64(mac)) throw new TrustStoreError('trust-lock-malformed', 'lock token or MAC is malformed');
    if (fields.type !== 'trust-lock' || fields.format !== FORMAT || !is.uuid(fields.transactionId) || !is.uuid(fields.projectIdentity) || !is.hex64(fields.keyId)) {
      throw new TrustStoreError('trust-lock-malformed', 'lock fields are malformed');
    }
    if (!equal(hmac(await key(), 'trust-lock', fields), mac)) throw new TrustStoreError('trust-lock-unauthenticated', 'lock MAC does not verify');
    if (fields.transactionId !== token || fields.projectIdentity !== binding.projectIdentity || fields.ownerScope !== scope() || fields.slot !== slot || !equal(fields.keyId, machineKeyId(await key()))) {
      throw new TrustStoreError('trust-lock-foreign', 'lock belongs to another project, owner, key, or slot');
    }
    return fields;
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

  async function isFormat2Authoritative({ binding, slot, rawBytes }) {
    try {
      const manifest = await readManifest(binding, slot); if (!manifest || !await verifyAuditChain(binding, slot)) return false;
      const event = await readAudit(binding, manifest.auditHeadId); if (!event) return false;
      const file = recordPath(binding, slot, manifest.currentGeneration, event.eventId);
      const record = await readImmutableRecord(file); if (!record) return false;
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

  async function writeJournal(binding, eventId, fields) { return writeAtomic(journalPath(binding, eventId), await signed('transaction-journal', fields)); }

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
      const recordId = crypto.randomUUID();
      const approvedAt = nowIso(now);
      const priorManifestHash = prior ? hash(await readOwnerOnlyFile(manifestPath(binding, slot), options)) : null;
      const journal = { format: FORMAT, type: 'transaction-journal', transactionId: eventId, projectIdentity: binding.projectIdentity, ownerScope: scope(), slot, candidateGeneration: generation, priorManifestHash, recordId, auditEventId: eventId, recordHash: null, auditHash: null, state: 'journal-prepared', keyId };
      await writeJournal(binding, eventId, journal);
      await onStep('journal-prepared');

      const recordFields = { format: FORMAT, type: 'slot-record', recordId, projectIdentity: binding.projectIdentity, ownerScope: scope(), slot, generation, rawHash: hash(value), contentHash: contentHash(value), normAlgo: NORM_ALGO, normVersion: NORM_VERSION, sourceOrigin, approvalEventId: eventId, previousRecordId: prior?.currentRecordId ?? null, auditEventId: eventId, approvedAt, keyId };
      const record = { ...recordFields, mac: hmac(machineKey, 'slot-record', recordFields) };
      const recordFile = recordPath(binding, slot, generation, eventId);
      await writeExclusive(recordFile, record);
      const recordHash = hash(await readOwnerOnlyFile(recordFile, options));
      await writeJournal(binding, eventId, { ...journal, recordHash, state: 'record-created' });
      await onStep('record-created');

      const auditFields = { format: FORMAT, type: 'audit-event', eventId, eventType: 'phase4a', projectIdentity: binding.projectIdentity, ownerScope: scope(), slot, generation, recordId, recordHash, previousGeneration: prior?.currentGeneration ?? 0, previousRecordId: prior?.currentRecordId ?? null, previousAuditEventId: prior?.auditHeadId ?? null, previousAuditEventHash: prior?.auditHeadHash ?? null, normAlgo: NORM_ALGO, normVersion: NORM_VERSION, rawHash: record.rawHash, contentHash: record.contentHash, keyId, timestamp: approvedAt };
      const audit = { ...auditFields, mac: hmac(machineKey, 'audit-event', auditFields) };
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
      const manifestFields = { format: FORMAT, type: 'manifest', projectIdentity: binding.projectIdentity, ownerScope: scope(), slot, currentGeneration: generation, currentRecordId: recordId, currentRecordHash: recordHash, auditHeadId: eventId, auditHeadHash: auditHash, keyId };
      const manifest = { ...manifestFields, mac: hmac(machineKey, 'manifest', manifestFields) };
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

  async function quarantine(file) { await fs.rename(file, `${file}.quarantine`).catch(() => undefined); }

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
      const recRaw = await readOwnerOnlyFile(recordPath(binding, slot, journal.candidateGeneration, journal.auditEventId), options).catch(() => null);
      if (!recRaw || !journal.recordHash || !equal(hash(recRaw), journal.recordHash)) return 'quarantine';
    }
    if (journal.state === 'audit-event-created') {
      const evtRaw = await readOwnerOnlyFile(auditPath(binding, journal.auditEventId), options).catch(() => null);
      if (!evtRaw || !journal.auditHash || !equal(hash(evtRaw), journal.auditHash)) return 'quarantine';
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
          verifyMac(await key(), 'transaction-journal', journal);
        } catch { await quarantine(file); continue; }
        if (journal.projectIdentity !== binding.projectIdentity || journal.slot !== slot) { await quarantine(file); continue; }
        const disposition = await journalDisposition(binding, slot, journal);
        if (disposition === 'ambiguous') throw new TrustStoreError('recovery-ambiguous', 'committed journal does not match manifest');
        if (disposition === 'quarantine') { await quarantine(file); continue; }
        await fs.rm(file, { force: true });
      }
    } finally {
      await lock.release().catch(() => undefined);
    }
  }

  return Object.freeze({
    createProjectBinding, readProjectBinding, readImmutableRecord, readManifest, readAudit,
    acquireLock, inspectLock, verifyAuditChain, isFormat2Authoritative, commitTransaction, recover,
    ensureMachineKey: key,
    bindingPath, manifestPath, auditPath, recordPath, journalPath, lockPath,
    pathFor: (binding, relative) => path.join(rootFor(binding), relative),
    // Low-level helpers reused by the test-only harness to seed adversarial state.
    _internal: Object.freeze({ signed, writeExclusive, hmac, hash, contentHash, machineKeyId, scope, nowIso: () => nowIso(now) }),
  });
}
