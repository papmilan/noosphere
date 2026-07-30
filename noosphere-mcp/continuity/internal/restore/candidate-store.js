import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { normalizeUntrusted } from '../../memory-safety.js';
import {
  assertContainedChain,
  ensureRealDirectoryPath,
  readBoundedRegularFile,
  writeOwnerOnlyFileExclusive,
} from '../../secure-fs.js';
import { baselineBody } from '../../slot-sources.js';
import {
  MAX_TRUST_RECORD_BYTES,
  TrustStoreError,
  canonicalize,
} from '../../trust-store-internal.js';
import {
  AUTH_DOMAINS,
  sealRecord,
  verifyRecord,
} from '../authenticated-records.js';
import {
  assertInteractiveStreams,
} from '../exact-confirmation.js';
import { createFormatV2Store } from '../trust-format-v2.js';
import {
  decodeCanonicalCandidateId,
  generateCandidateId,
} from './cli.js';
import {
  ACTIVE_RETENTION_MS,
  AUTHORITY_PAYLOAD_BYTES,
  RESTORE_RECORD_BYTES,
  RESTORE_SLOTS,
} from './constants.js';
import { recallRestoreSource } from './recall.js';
import {
  CANDIDATE_TRANSITIONS,
  createStateMachine,
  readStateMachine,
  transitionStateMachine,
} from './state-machine.js';

const UTF8 = new TextDecoder('utf-8', { fatal: true });
const ENVELOPE_FIELDS = new Set([
  'byteLength',
  'candidateId',
  'createdAt',
  'derivedByteLength',
  'derivedNormalizedHash',
  'derivedRawHash',
  'domain',
  'expiresAt',
  'keyId',
  'mac',
  'payloadHash',
  'projectIdentityDigest',
  'remoteMetadata',
  'schema',
  'slot',
  'state',
  'trustLabel',
  'version',
]);

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function restoreError(code, message) {
  return new TrustStoreError(code, message);
}

function hasExactFields(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === expected.size &&
    Object.keys(value).every(key => expected.has(key));
}

function validTimestamp(value) {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function deriveSlotBytes(slot, content) {
  let text;
  try {
    text = UTF8.decode(content);
  } catch {
    throw restoreError(
      'restore-candidate-content-invalid',
      'candidate payload is not valid UTF-8',
    );
  }
  return Buffer.from(slot === 'baseline' ? baselineBody(text) : text, 'utf8');
}

function normalizedHash(bytes) {
  let text;
  try {
    text = UTF8.decode(bytes);
  } catch {
    throw restoreError(
      'restore-candidate-content-invalid',
      'candidate derived bytes are not valid UTF-8',
    );
  }
  return hash(Buffer.from(normalizeUntrusted(text), 'utf8'));
}

function validateEnvelope(envelope, { candidateId, binding, identityDigest }) {
  const metadata = envelope?.remoteMetadata;
  const metadataValuesValid = metadata &&
    metadata.actionType === RESTORE_SLOTS[envelope.slot]?.actionType &&
    ['actionId', 'agentId', 'blobId', 'timestamp'].every(field =>
      metadata[field] === null ||
      (typeof metadata[field] === 'string' &&
       Buffer.byteLength(metadata[field], 'utf8') <= 4_096));
  if (!hasExactFields(envelope, ENVELOPE_FIELDS) ||
      envelope.domain !== AUTH_DOMAINS.restoreCandidate ||
      envelope.schema !== 'noosphere.restore-candidate' ||
      envelope.version !== 1 ||
      envelope.candidateId !== candidateId ||
      !Object.hasOwn(RESTORE_SLOTS, envelope.slot) ||
      envelope.projectIdentityDigest !== identityDigest ||
      envelope.keyId !== binding.keyId ||
      envelope.trustLabel !== 'untrusted' ||
      envelope.state !== 'active' ||
      !Number.isInteger(envelope.byteLength) ||
      envelope.byteLength < 1 ||
      envelope.byteLength > AUTHORITY_PAYLOAD_BYTES ||
      !Number.isInteger(envelope.derivedByteLength) ||
      envelope.derivedByteLength < 0 ||
      envelope.derivedByteLength > AUTHORITY_PAYLOAD_BYTES ||
      !/^[0-9a-f]{64}$/.test(envelope.payloadHash) ||
      !/^[0-9a-f]{64}$/.test(envelope.derivedRawHash) ||
      !/^[0-9a-f]{64}$/.test(envelope.derivedNormalizedHash) ||
      !validTimestamp(envelope.createdAt) ||
      !validTimestamp(envelope.expiresAt) ||
      new Date(envelope.expiresAt).getTime() -
        new Date(envelope.createdAt).getTime() !== ACTIVE_RETENTION_MS ||
      !hasExactFields(envelope.remoteMetadata, new Set([
        'actionId',
        'actionType',
        'agentId',
        'blobId',
        'timestamp',
      ])) ||
      !metadataValuesValid) {
    throw restoreError(
      'restore-candidate-envelope-invalid',
      'restore candidate envelope is invalid',
    );
  }
}

async function readCanonicalEnvelope(file) {
  const bytes = await readCandidateFile(
    file,
    Math.min(RESTORE_RECORD_BYTES, MAX_TRUST_RECORD_BYTES),
  );
  if (bytes === null) {
    throw restoreError(
      'restore-candidate-missing',
      'restore candidate envelope is missing',
    );
  }
  let text;
  let parsed;
  try {
    text = UTF8.decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    throw restoreError(
      'restore-candidate-envelope-invalid',
      'restore candidate envelope is malformed',
    );
  }
  if (text !== canonicalize(parsed)) {
    throw restoreError(
      'restore-candidate-envelope-invalid',
      'restore candidate envelope is not canonical',
    );
  }
  return parsed;
}

async function readCandidateFile(file, maxBytes) {
  try {
    return await readBoundedRegularFile(file, { maxBytes });
  } catch (error) {
    throw restoreError(
      'restore-candidate-unsafe',
      `restore candidate file is unsafe: ${error.code ?? 'read-failed'}`,
    );
  }
}

function candidatePaths(store, binding, candidateId) {
  const root = store.pathFor(binding, path.join('restore', 'candidates'));
  const directory = path.join(root, candidateId);
  return Object.freeze({
    root,
    directory,
    envelope: path.join(directory, 'envelope.json'),
    payload: path.join(directory, 'payload.bin'),
    derived: path.join(directory, 'derived.bin'),
  });
}

function candidateStateExpected(binding, envelope) {
  return Object.freeze({
    domain: AUTH_DOMAINS.restoreCandidate,
    entityKind: 'candidate',
    entityId: envelope.candidateId,
    projectIdentityDigest: envelope.projectIdentityDigest,
    keyId: binding.keyId,
  });
}

async function assertSafeCandidateChain(store, binding, directory) {
  try {
    const result = await assertContainedChain(
      store.pathFor(binding, ''),
      directory,
    );
    if (result === null) {
      throw restoreError(
        'restore-candidate-missing',
        'restore candidate path is missing',
      );
    }
  } catch (error) {
    if (error instanceof TrustStoreError) throw error;
    throw restoreError(
      'restore-candidate-unsafe',
      `restore candidate directory is unsafe: ${error.code ?? 'invalid'}`,
    );
  }
}

async function readCandidate({
  projectRoot,
  env,
  secureFileOptions,
  candidateId,
}) {
  decodeCanonicalCandidateId(candidateId);
  const store = createFormatV2Store({ env, secureFileOptions });
  const binding = await store.readProjectBinding(projectRoot);
  const identityDigest = await store.canonicalProjectIdentityDigest(projectRoot);
  const paths = candidatePaths(store, binding, candidateId);
  await assertSafeCandidateChain(store, binding, paths.directory);
  const directoryStat = await fs.lstat(paths.directory).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw restoreError(
      'restore-candidate-unsafe',
      `restore candidate directory is unreadable: ${error.code ?? 'invalid'}`,
    );
  });
  if (!directoryStat) {
    throw restoreError('restore-candidate-missing', 'restore candidate is missing');
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw restoreError(
      'restore-candidate-unsafe',
      'restore candidate path is unsafe',
    );
  }
  const envelope = await readCanonicalEnvelope(paths.envelope);
  validateEnvelope(envelope, { candidateId, binding, identityDigest });
  if (!verifyRecord(
    await store.ensureMachineKey(),
    AUTH_DOMAINS.restoreCandidate,
    envelope,
  )) {
    throw restoreError(
      'restore-candidate-unauthenticated',
      'restore candidate MAC does not verify',
    );
  }
  const [content, derivedSlotBytes] = await Promise.all([
    readCandidateFile(paths.payload, AUTHORITY_PAYLOAD_BYTES),
    readCandidateFile(paths.derived, AUTHORITY_PAYLOAD_BYTES),
  ]);
  if (content === null || derivedSlotBytes === null ||
      content.length !== envelope.byteLength ||
      derivedSlotBytes.length !== envelope.derivedByteLength ||
      hash(content) !== envelope.payloadHash ||
      hash(derivedSlotBytes) !== envelope.derivedRawHash ||
      normalizedHash(derivedSlotBytes) !== envelope.derivedNormalizedHash ||
      !deriveSlotBytes(envelope.slot, content).equals(derivedSlotBytes)) {
    throw restoreError(
      'restore-candidate-content-invalid',
      'restore candidate bytes do not match the authenticated envelope',
    );
  }
  const candidateState = await readStateMachine({
    root: paths.directory,
    key: await store.ensureMachineKey(),
    expected: candidateStateExpected(binding, envelope),
    transitions: CANDIDATE_TRANSITIONS,
    secureFileOptions,
  });
  return Object.freeze({
    ...envelope,
    content,
    derivedSlotBytes,
    candidateState,
  });
}

export async function matchRestoreCandidateByTuple({
  projectRoot,
  slot,
  candidatePayloadHash,
  env = process.env,
  secureFileOptions = {},
  now = () => new Date(),
} = {}) {
  if (
    !Object.hasOwn(RESTORE_SLOTS, slot) ||
    typeof candidatePayloadHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(candidatePayloadHash)
  ) {
    throw restoreError(
      'restore-candidate-match-invalid',
      'restore candidate match tuple is invalid',
    );
  }
  const store = createFormatV2Store({ env, secureFileOptions });
  const binding = await store.readProjectBinding(projectRoot);
  const root = store.pathFor(binding, path.join('restore', 'candidates'));
  const safeRoot = await assertContainedChain(store.pathFor(binding, ''), root);
  if (safeRoot === null) return Object.freeze({ status: 'absent' });
  const observedNow = now();
  if (!(observedNow instanceof Date) || Number.isNaN(observedNow.getTime())) {
    throw restoreError('restore-clock-invalid', 'restore clock is invalid');
  }
  const matches = [];
  for (const entry of (await fs.readdir(root, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    if (!/^[a-z2-7]{52}$/.test(entry.name)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw restoreError(
        'restore-candidate-unsafe',
        'candidate-shaped staging entry is unsafe',
      );
    }
    const candidate = await readCandidate({
      projectRoot,
      env,
      secureFileOptions,
      candidateId: entry.name,
    });
    if (
      candidate.slot === slot &&
      candidate.payloadHash === candidatePayloadHash
    ) {
      matches.push(candidate);
    }
  }
  if (matches.length > 1) {
    throw restoreError(
      'restore-candidate-match-conflict',
      'multiple authenticated restore candidates match the trusted tuple',
    );
  }
  if (matches.length === 0) return Object.freeze({ status: 'absent' });
  const candidate = matches[0];
  if (candidate.candidateState.state === 'apply-in-progress') {
    return Object.freeze({
      status: 'apply-in-progress',
      candidateId: candidate.candidateId,
    });
  }
  if (candidate.candidateState.state === 'consumed') {
    const { readConsumedMarker } = await import('./receipt-store.js');
    const marker = await readConsumedMarker({
      projectRoot,
      env,
      secureFileOptions,
      candidateId: candidate.candidateId,
    });
    if (
      marker.candidatePayloadHash !== candidatePayloadHash ||
      marker.slot !== slot
    ) {
      throw restoreError(
        'restore-candidate-match-conflict',
        'consumed marker conflicts with its matching candidate',
      );
    }
    return Object.freeze({
      status: 'consumed',
      candidateId: candidate.candidateId,
      outcome: marker.outcome,
    });
  }
  if (
    candidate.candidateState.state !== 'active' ||
    Date.parse(candidate.expiresAt) <= observedNow.getTime()
  ) {
    return Object.freeze({ status: 'absent' });
  }
  return Object.freeze({ status: 'active', candidate });
}

export async function createRestoreCandidateFromSource({
  projectRoot,
  slot,
  source,
  env = process.env,
  secureFileOptions = {},
  randomBytes,
  now = () => new Date(),
} = {}) {
  if (!Object.hasOwn(RESTORE_SLOTS, slot) ||
      !source || !Buffer.isBuffer(source.content)) {
    throw restoreError(
      'restore-candidate-create-invalid',
      'restore candidate creation input is invalid',
    );
  }
  const derivedSlotBytes = deriveSlotBytes(slot, source.content);
  const store = createFormatV2Store({ env, secureFileOptions });
  const binding = await store.createProjectBinding(projectRoot);
  const key = await store.ensureMachineKey();
  const projectIdentityDigest =
    await store.canonicalProjectIdentityDigest(projectRoot);
  const root = store.pathFor(binding, path.join('restore', 'candidates'));
  await ensureRealDirectoryPath(root);
  const observedNow = now();
  if (!(observedNow instanceof Date) ||
      Number.isNaN(observedNow.getTime())) {
    throw restoreError('restore-clock-invalid', 'restore clock is invalid');
  }

  for (let collision = 0; collision < 128; collision += 1) {
    const candidateId = generateCandidateId(randomBytes);
    const paths = candidatePaths(store, binding, candidateId);
    try {
      await fs.mkdir(paths.directory, { mode: 0o700 });
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw error;
    }
    const fields = {
      domain: AUTH_DOMAINS.restoreCandidate,
      schema: 'noosphere.restore-candidate',
      version: 1,
      candidateId,
      slot,
      payloadHash: hash(source.content),
      byteLength: source.content.length,
      derivedRawHash: hash(derivedSlotBytes),
      derivedNormalizedHash: normalizedHash(derivedSlotBytes),
      derivedByteLength: derivedSlotBytes.length,
      trustLabel: 'untrusted',
      remoteMetadata: source.metadata,
      projectIdentityDigest,
      createdAt: observedNow.toISOString(),
      expiresAt: new Date(
        observedNow.getTime() + ACTIVE_RETENTION_MS,
      ).toISOString(),
      state: 'active',
      keyId: binding.keyId,
    };
    const envelope = sealRecord(key, AUTH_DOMAINS.restoreCandidate, fields);
    try {
      await writeOwnerOnlyFileExclusive(
        paths.payload,
        source.content,
        secureFileOptions,
      );
      await writeOwnerOnlyFileExclusive(
        paths.derived,
        derivedSlotBytes,
        secureFileOptions,
      );
      await writeOwnerOnlyFileExclusive(
        paths.envelope,
        canonicalize(envelope),
        secureFileOptions,
      );
      await createStateMachine({
        root: paths.directory,
        key,
        expected: candidateStateExpected(binding, envelope),
        initialState: 'active',
        now: observedNow,
        secureFileOptions,
      });
      const candidate = await readCandidate({
        projectRoot,
        env,
        secureFileOptions,
        candidateId,
      });
      return Object.freeze({ status: 'staged', candidate });
    } catch (error) {
      await fs.rm(paths.directory, { recursive: true, force: true })
        .catch(() => undefined);
      throw error;
    }
  }
  throw restoreError(
    'restore-candidate-collision-limit',
    'restore candidate identifier collisions exceeded the fixed retry limit',
  );
}

export async function stageRestoreCandidate({
  projectRoot,
  slot,
  env = process.env,
  secureFileOptions = {},
  input = process.stdin,
  output = process.stdout,
  recall,
  recallSource,
  randomBytes,
  now = () => new Date(),
} = {}) {
  if (!Object.hasOwn(RESTORE_SLOTS, slot)) {
    throw restoreError('restore-slot-invalid', 'restore slot is invalid');
  }
  assertInteractiveStreams({
    input,
    output,
    code: 'restore-stage-requires-tty',
    message: 'restore staging requires an interactive terminal',
  });
  const source = recallSource
    ? await recallSource({ slot })
    : await recallRestoreSource({ slot, recall });
  if (source === null) return Object.freeze({ status: 'no-candidate' });
  return createRestoreCandidateFromSource({
    projectRoot,
    slot,
    source,
    env,
    secureFileOptions,
    randomBytes,
    now,
  });
}

/**
 * Every candidate currently marked `apply-in-progress`, whatever its expiry.
 *
 * listRestoreCandidates deliberately returns only ACTIVE, unexpired candidates —
 * it answers "what can the owner apply?". Recovery needs the opposite question:
 * a crash between markApplyInProgress and createApplyJournal leaves a candidate
 * mid-apply with a spent confirmation and NO journal, which is invisible to
 * every other listing and can never be applied or restaged again. Read-only.
 */
export async function listApplyInProgressCandidates({
  projectRoot,
  env = process.env,
  secureFileOptions = {},
} = {}) {
  const store = createFormatV2Store({ env, secureFileOptions });
  let binding;
  try {
    binding = await store.readProjectBinding(projectRoot);
  } catch (error) {
    if (error.code === 'binding-invalid') return Object.freeze([]);
    throw error;
  }
  const root = store.pathFor(binding, path.join('restore', 'candidates'));
  const safeRoot = await assertContainedChain(store.pathFor(binding, ''), root)
    .catch(error => {
      throw restoreError(
        'restore-candidate-unsafe',
        `restore candidate root is unsafe: ${error.code ?? 'invalid'}`,
      );
    });
  if (safeRoot === null) return Object.freeze([]);
  const entries = await fs.readdir(root, { withFileTypes: true })
    .catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
  const stranded = [];
  for (const entry of entries) {
    if (!/^[a-z2-7]{52}$/.test(entry.name)) continue;
    decodeCanonicalCandidateId(entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw restoreError(
        'restore-candidate-unsafe',
        'candidate-shaped staging entry is unsafe',
      );
    }
    const candidate = await readCandidate({
      projectRoot, env, secureFileOptions, candidateId: entry.name,
    });
    if (candidate.candidateState.state !== 'apply-in-progress') continue;
    stranded.push(Object.freeze({
      candidateId: entry.name,
      slot: candidate.slot,
      payloadHash: candidate.payloadHash,
      candidateState: candidate.candidateState,
    }));
  }
  stranded.sort((left, right) => left.candidateId.localeCompare(right.candidateId));
  return Object.freeze(stranded);
}

export async function listRestoreCandidates({
  projectRoot,
  env = process.env,
  secureFileOptions = {},
  now = () => new Date(),
} = {}) {
  const store = createFormatV2Store({ env, secureFileOptions });
  let binding;
  try {
    binding = await store.readProjectBinding(projectRoot);
  } catch (error) {
    if (error.code === 'binding-invalid') return Object.freeze([]);
    throw error;
  }
  const root = store.pathFor(binding, path.join('restore', 'candidates'));
  const projectStoreRoot = store.pathFor(binding, '');
  const safeRoot = await assertContainedChain(projectStoreRoot, root)
    .catch(error => {
      throw restoreError(
        'restore-candidate-unsafe',
        `restore candidate root is unsafe: ${error.code ?? 'invalid'}`,
      );
    });
  if (safeRoot === null) return Object.freeze([]);
  const entries = await fs.readdir(root, { withFileTypes: true })
    .catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
  const active = [];
  const observedNow = now();
  if (!(observedNow instanceof Date) ||
      Number.isNaN(observedNow.getTime())) {
    throw restoreError('restore-clock-invalid', 'restore clock is invalid');
  }
  for (const entry of entries) {
    if (!/^[a-z2-7]{52}$/.test(entry.name)) continue;
    try {
      decodeCanonicalCandidateId(entry.name);
    } catch {
      throw restoreError(
        'restore-candidate-invalid-name',
        'candidate-shaped staging entry has a noncanonical name',
      );
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw restoreError(
        'restore-candidate-unsafe',
        'candidate-shaped staging entry is unsafe',
      );
    }
    const candidate = await readCandidate({
      projectRoot,
      env,
      secureFileOptions,
      candidateId: entry.name,
    });
    if (new Date(candidate.expiresAt).getTime() <= observedNow.getTime()) {
      continue;
    }
    if (candidate.candidateState.state !== 'active') continue;
    const {
      content: ignoredContent,
      derivedSlotBytes: ignoredDerived,
      candidateState: ignoredState,
      ...metadata
    } = candidate;
    active.push(Object.freeze(metadata));
  }
  active.sort((left, right) => left.candidateId.localeCompare(right.candidateId));
  return Object.freeze(active);
}

export function showRestoreCandidate(input) {
  return readCandidate(input);
}

export async function readCandidateState(input) {
  return (await readCandidate(input)).candidateState;
}

export async function markApplyInProgress({
  projectRoot,
  env = process.env,
  secureFileOptions = {},
  candidateId,
  contextId,
  transactionId,
  now = () => new Date(),
} = {}) {
  const candidate = await readCandidate({
    projectRoot,
    env,
    secureFileOptions,
    candidateId,
  });
  if (candidate.candidateState.state === 'consumed') {
    throw restoreError(
      'ERR_RESTORE_CANDIDATE_CONSUMED',
      'restore candidate is already consumed',
    );
  }
  if (candidate.candidateState.state !== 'active') {
    throw restoreError(
      'ERR_RESTORE_CANDIDATE_IN_PROGRESS',
      'restore candidate is already apply-in-progress',
    );
  }
  const { readConfirmation } = await import('./confirmation-store.js');
  const confirmation = await readConfirmation({
    projectRoot,
    env,
    secureFileOptions,
    contextId,
  });
  if (confirmation.state !== 'spent' ||
      confirmation.transactionId !== transactionId ||
      confirmation.candidateId !== candidateId ||
      confirmation.candidatePayloadHash !== candidate.payloadHash ||
      confirmation.projectIdentityDigest !== candidate.projectIdentityDigest) {
    throw restoreError(
      'ERR_RESTORE_CANDIDATE_TRANSITION',
      'restore candidate requires its own spent confirmation transaction',
    );
  }
  const store = createFormatV2Store({ env, secureFileOptions });
  const binding = await store.readProjectBinding(projectRoot);
  return transitionStateMachine({
    root: candidatePaths(store, binding, candidateId).directory,
    key: await store.ensureMachineKey(),
    expected: candidateStateExpected(binding, candidate),
    transitions: CANDIDATE_TRANSITIONS,
    to: 'apply-in-progress',
    code: 'ERR_RESTORE_CANDIDATE_TRANSITION',
    metadata: { contextId, transactionId },
    now: now(),
    secureFileOptions,
  });
}

export async function consumeCandidate({
  projectRoot,
  env = process.env,
  secureFileOptions = {},
  candidateId,
  transactionId,
  outcome,
  now = () => new Date(),
} = {}) {
  const candidate = await readCandidate({
    projectRoot,
    env,
    secureFileOptions,
    candidateId,
  });
  if (candidate.candidateState.state === 'consumed') {
    throw restoreError(
      'ERR_RESTORE_CANDIDATE_CONSUMED',
      'restore candidate is already consumed',
    );
  }
  if (candidate.candidateState.state !== 'apply-in-progress' ||
      candidate.candidateState.transactionId !== transactionId ||
      !['applied', 'failed'].includes(outcome)) {
    throw restoreError(
      'ERR_RESTORE_CANDIDATE_TRANSITION',
      'restore candidate cannot be consumed by this transaction',
    );
  }
  const store = createFormatV2Store({ env, secureFileOptions });
  const binding = await store.readProjectBinding(projectRoot);
  return transitionStateMachine({
    root: candidatePaths(store, binding, candidateId).directory,
    key: await store.ensureMachineKey(),
    expected: candidateStateExpected(binding, candidate),
    transitions: CANDIDATE_TRANSITIONS,
    to: 'consumed',
    code: 'ERR_RESTORE_CANDIDATE_TRANSITION',
    metadata: {
      contextId: candidate.candidateState.contextId,
      transactionId,
      outcome,
    },
    now: now(),
    secureFileOptions,
  });
}

export async function cleanupExpiredCandidates({
  projectRoot,
  env = process.env,
  secureFileOptions = {},
  now = () => new Date(),
} = {}) {
  const store = createFormatV2Store({ env, secureFileOptions });
  let binding;
  try {
    binding = await store.readProjectBinding(projectRoot);
  } catch (error) {
    if (error.code === 'binding-invalid') return 0;
    throw error;
  }
  const root = store.pathFor(binding, path.join('restore', 'candidates'));
  const safeRoot = await assertContainedChain(store.pathFor(binding, ''), root)
    .catch(error => {
      throw restoreError(
        'restore-candidate-unsafe',
        `restore candidate root is unsafe: ${error.code ?? 'invalid'}`,
      );
    });
  if (safeRoot === null) return 0;
  const entries = await fs.readdir(root, { withFileTypes: true })
    .catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
  const referenceRoots = [
    'confirmations',
    'apply',
    'receipts',
    'consumed',
  ].map(name => store.pathFor(binding, path.join('restore', name)));
  for (const referenceRoot of referenceRoots) {
    const references = await fs.readdir(referenceRoot).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    // Conservatively retain every expired candidate while any later-phase
    // restore fact exists. Later state machines can narrow this to exact
    // candidate references without risking early deletion.
    if (references.length > 0) return 0;
  }
  const observedNow = now();
  if (!(observedNow instanceof Date) ||
      Number.isNaN(observedNow.getTime())) {
    throw restoreError('restore-clock-invalid', 'restore clock is invalid');
  }
  let removed = 0;
  for (const entry of entries) {
    if (!/^[a-z2-7]{52}$/.test(entry.name)) continue;
    const candidate = await readCandidate({
      projectRoot,
      env,
      secureFileOptions,
      candidateId: entry.name,
    });
    if (new Date(candidate.expiresAt).getTime() > observedNow.getTime()) continue;
    const paths = candidatePaths(store, binding, entry.name);
    await fs.rm(paths.directory, { recursive: true });
    removed += 1;
  }
  return removed;
}
