import fs from 'node:fs/promises';
import path from 'node:path';

import {
  assertContainedChain,
  ensureRealDirectoryPath,
  readBoundedRegularFile,
  writeOwnerOnlyFileExclusive,
} from '../../secure-fs.js';
import { TrustStoreError, canonicalize } from '../../trust-store-internal.js';
import { AUTH_DOMAINS, sealRecord, verifyRecord } from '../authenticated-records.js';
import { createFormatV2Store } from '../trust-format-v2.js';
import { decodeCanonicalCandidateId } from './cli.js';
import { RESTORE_RECORD_BYTES, RESTORE_SLOTS } from './constants.js';
import {
  APPLY_JOURNAL_STATES,
  APPLY_TRANSITIONS,
  createStateMachine,
  readStateMachine,
  transitionStateMachine,
} from './state-machine.js';

export { APPLY_JOURNAL_STATES, APPLY_TRANSITIONS };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const IDENTITY = /^sha256:[0-9a-f]{64}$/;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

const ENVELOPE_FIELDS = new Set([
  'bindingId',
  'candidateId',
  'candidatePayloadHash',
  'confirmationEventHash',
  'consumedMarkerCandidateId',
  'contextId',
  'createdAt',
  'destination',
  'destinationAfterHash',
  'destinationBefore',
  'domain',
  'keyId',
  'mac',
  'manifest',
  'projectIdentityDigest',
  'receiptId',
  'schema',
  'slot',
  'temporaryPath',
  'transactionId',
  'version',
]);

function journalError(code, message) {
  return new TrustStoreError(code, message);
}

function invalid(message) {
  return journalError('ERR_RESTORE_JOURNAL_INVALID', message);
}

/**
 * The apply temporary file name is a pure function of the fixed destination and
 * the transaction ID, so recovery can locate — and authenticate — the temporary
 * file of a crashed transaction without any additional persisted state.
 */
export function temporaryRelativePath(slot, transactionId) {
  const relative = RESTORE_SLOTS[slot]?.destination;
  if (!relative || !UUID.test(transactionId)) {
    throw invalid('restore apply temporary path inputs are invalid');
  }
  const segments = relative.split('/');
  const name = segments.pop();
  return [...segments, `.${name}.${transactionId}.restore-tmp`].join('/');
}

export function assertNextApplyState(previous, next) {
  const from = APPLY_JOURNAL_STATES.indexOf(previous);
  const to = APPLY_JOURNAL_STATES.indexOf(next);
  if (from < 0 || to <= from || !APPLY_TRANSITIONS[previous]?.has(next)) {
    throw journalError(
      'ERR_RESTORE_JOURNAL_SEQUENCE',
      'invalid apply journal sequence',
    );
  }
}

function journalPaths(store, binding, transactionId) {
  const root = store.pathFor(binding, path.join('restore', 'apply'));
  const directory = transactionId ? path.join(root, transactionId) : null;
  return Object.freeze({
    root,
    directory,
    envelope: directory ? path.join(directory, 'envelope.json') : null,
  });
}

function journalStateExpected(binding, envelope) {
  return Object.freeze({
    domain: AUTH_DOMAINS.restoreApplyJournal,
    entityKind: 'apply',
    entityId: envelope.transactionId,
    projectIdentityDigest: envelope.projectIdentityDigest,
    keyId: binding.keyId,
  });
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

export function validDestinationBinding(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.state === 'absent') return Object.keys(value).length === 1;
  return value.state === 'present' &&
    Object.keys(value).length === 2 &&
    HASH.test(value.rawHash);
}

export function validManifestBinding(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'generation' || keys[1] !== 'state') {
    return false;
  }
  const generation = value.generation;
  if (!generation || typeof generation !== 'object' || Array.isArray(generation)) {
    return false;
  }
  if (value.state === 'pristine-unapproved') {
    return Object.keys(generation).length === 1 &&
      generation.state === 'no-manifest';
  }
  return ['approved', 'revoked'].includes(value.state) &&
    Object.keys(generation).length === 2 &&
    generation.state === 'present' &&
    Number.isInteger(generation.value) &&
    generation.value >= 1;
}

function validateEnvelope(envelope, { binding, identityDigest, transactionId }) {
  if (!exactFields(envelope, ENVELOPE_FIELDS) ||
      envelope.domain !== AUTH_DOMAINS.restoreApplyJournal ||
      envelope.schema !== 'noosphere.restore-apply-journal' ||
      envelope.version !== 1 ||
      !UUID.test(envelope.transactionId) ||
      (transactionId !== undefined && envelope.transactionId !== transactionId) ||
      envelope.receiptId !== envelope.transactionId ||
      !UUID.test(envelope.contextId) ||
      !HASH.test(envelope.confirmationEventHash) ||
      !HASH.test(envelope.candidatePayloadHash) ||
      !HASH.test(envelope.destinationAfterHash) ||
      envelope.consumedMarkerCandidateId !== envelope.candidateId ||
      !Object.hasOwn(RESTORE_SLOTS, envelope.slot) ||
      envelope.destination !== RESTORE_SLOTS[envelope.slot].destination ||
      envelope.temporaryPath !==
        temporaryRelativePath(envelope.slot, envelope.transactionId) ||
      !IDENTITY.test(envelope.projectIdentityDigest) ||
      envelope.projectIdentityDigest !== identityDigest ||
      !HASH.test(envelope.keyId) ||
      envelope.keyId !== binding.keyId ||
      !UUID.test(envelope.bindingId) ||
      envelope.bindingId !== binding.projectIdentity ||
      !validDestinationBinding(envelope.destinationBefore) ||
      !validManifestBinding(envelope.manifest) ||
      !canonicalTimestamp(envelope.createdAt)) {
    throw invalid('restore apply journal envelope is invalid');
  }
  decodeCanonicalCandidateId(envelope.candidateId);
}

async function readCanonicalEnvelope(file, secureFileOptions) {
  let bytes;
  try {
    bytes = await readBoundedRegularFile(file, {
      maxBytes: RESTORE_RECORD_BYTES,
      ...secureFileOptions,
    });
  } catch (error) {
    throw invalid(`restore apply journal path is unsafe: ${error.code ?? 'read-failed'}`);
  }
  if (bytes === null) {
    throw journalError(
      'ERR_RESTORE_JOURNAL_MISSING',
      'restore apply journal envelope is missing',
    );
  }
  let text;
  let parsed;
  try {
    text = UTF8.decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    throw invalid('restore apply journal envelope is malformed');
  }
  if (text !== canonicalize(parsed)) {
    throw invalid('restore apply journal envelope is not canonical');
  }
  return parsed;
}

async function contextFor(projectRoot, env, secureFileOptions) {
  const store = createFormatV2Store({ env, secureFileOptions });
  const binding = await store.readProjectBinding(projectRoot);
  return {
    store,
    binding,
    key: await store.ensureMachineKey(),
    identityDigest: await store.canonicalProjectIdentityDigest(projectRoot),
  };
}

async function loadJournal(context, transactionId, secureFileOptions) {
  const paths = journalPaths(context.store, context.binding, transactionId);
  const safe = await assertContainedChain(
    context.store.pathFor(context.binding, ''),
    paths.directory,
  ).catch(error => {
    throw invalid(`restore apply journal directory is unsafe: ${error.code ?? 'invalid'}`);
  });
  if (safe === null) {
    throw journalError(
      'ERR_RESTORE_JOURNAL_MISSING',
      'restore apply journal is missing',
    );
  }
  const envelope = await readCanonicalEnvelope(paths.envelope, secureFileOptions);
  validateEnvelope(envelope, { ...context, transactionId });
  if (!verifyRecord(context.key, AUTH_DOMAINS.restoreApplyJournal, envelope)) {
    throw invalid('restore apply journal envelope MAC does not verify');
  }
  const state = await readStateMachine({
    root: paths.directory,
    key: context.key,
    expected: journalStateExpected(context.binding, envelope),
    transitions: APPLY_TRANSITIONS,
    secureFileOptions,
  });
  if (state.transactionId !== envelope.transactionId ||
      state.contextId !== envelope.contextId) {
    throw invalid('restore apply journal state is not bound to its transaction');
  }
  return Object.freeze({
    ...envelope,
    state: state.state,
    stateSequence: state.sequence,
    stateEventHash: state.eventHash,
    outcome: state.outcome,
    path: paths.directory,
  });
}

export async function createApplyJournal({
  projectRoot,
  env = process.env,
  secureFileOptions = {},
  transactionId,
  candidateId,
  candidatePayloadHash,
  contextId,
  confirmationEventHash,
  slot,
  destinationBefore,
  destinationAfterHash,
  manifest,
  now = () => new Date(),
} = {}) {
  if (!UUID.test(transactionId) || !UUID.test(contextId) ||
      !HASH.test(confirmationEventHash) || !HASH.test(candidatePayloadHash) ||
      !HASH.test(destinationAfterHash) || !Object.hasOwn(RESTORE_SLOTS, slot) ||
      !validDestinationBinding(destinationBefore) ||
      !validManifestBinding(manifest)) {
    throw invalid('restore apply journal input is invalid');
  }
  decodeCanonicalCandidateId(candidateId);
  const context = await contextFor(projectRoot, env, secureFileOptions);
  const paths = journalPaths(context.store, context.binding, transactionId);
  await ensureRealDirectoryPath(paths.directory);
  const observedNow = now();
  if (!(observedNow instanceof Date) || Number.isNaN(observedNow.getTime())) {
    throw invalid('restore apply journal time is invalid');
  }
  const envelope = sealRecord(context.key, AUTH_DOMAINS.restoreApplyJournal, {
    domain: AUTH_DOMAINS.restoreApplyJournal,
    schema: 'noosphere.restore-apply-journal',
    version: 1,
    transactionId,
    candidateId,
    candidatePayloadHash,
    contextId,
    confirmationEventHash,
    slot,
    destination: RESTORE_SLOTS[slot].destination,
    temporaryPath: temporaryRelativePath(slot, transactionId),
    destinationBefore,
    destinationAfterHash,
    manifest,
    receiptId: transactionId,
    consumedMarkerCandidateId: candidateId,
    bindingId: context.binding.projectIdentity,
    projectIdentityDigest: context.identityDigest,
    keyId: context.binding.keyId,
    createdAt: observedNow.toISOString(),
  });
  await writeOwnerOnlyFileExclusive(
    paths.envelope,
    canonicalize(envelope),
    secureFileOptions,
  );
  await createStateMachine({
    root: paths.directory,
    key: context.key,
    expected: journalStateExpected(context.binding, envelope),
    initialState: 'prepared',
    metadata: { contextId, transactionId },
    now: observedNow,
    secureFileOptions,
  });
  return loadJournal(context, transactionId, secureFileOptions);
}

export async function appendApplyJournalState({
  projectRoot,
  env = process.env,
  secureFileOptions = {},
  transactionId,
  to,
  outcome = null,
  now = () => new Date(),
} = {}) {
  const context = await contextFor(projectRoot, env, secureFileOptions);
  const journal = await loadJournal(context, transactionId, secureFileOptions);
  assertNextApplyState(journal.state, to);
  if ((to === 'complete') !== (outcome !== null)) {
    throw invalid('restore apply journal outcome does not match its state');
  }
  await transitionStateMachine({
    root: journalPaths(context.store, context.binding, transactionId).directory,
    key: context.key,
    expected: journalStateExpected(context.binding, journal),
    transitions: APPLY_TRANSITIONS,
    to,
    code: 'ERR_RESTORE_JOURNAL_SEQUENCE',
    metadata: {
      contextId: journal.contextId,
      transactionId,
      outcome,
    },
    now: now(),
    secureFileOptions,
  });
  return loadJournal(context, transactionId, secureFileOptions);
}

export async function listApplyJournals({
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
  const context = {
    store,
    binding,
    key: await store.ensureMachineKey(),
    identityDigest: await store.canonicalProjectIdentityDigest(projectRoot),
  };
  const root = journalPaths(store, binding, null).root;
  const safeRoot = await assertContainedChain(store.pathFor(binding, ''), root)
    .catch(error => {
      throw invalid(`restore apply journal root is unsafe: ${error.code ?? 'invalid'}`);
    });
  if (safeRoot === null) return Object.freeze([]);
  const entries = await fs.readdir(root, { withFileTypes: true })
    .catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
  const journals = [];
  for (const entry of entries) {
    if (!UUID.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
      throw invalid('restore apply journal root contains an invalid entry');
    }
    journals.push(await loadJournal(context, entry.name, secureFileOptions));
  }
  journals.sort((left, right) =>
    left.transactionId.localeCompare(right.transactionId));
  return Object.freeze(journals);
}

export async function readApplyJournal({
  projectRoot,
  env = process.env,
  secureFileOptions = {},
  transactionId,
  candidateId,
} = {}) {
  if (transactionId !== undefined) {
    if (!UUID.test(transactionId)) {
      throw invalid('restore apply transaction ID is invalid');
    }
    return loadJournal(
      await contextFor(projectRoot, env, secureFileOptions),
      transactionId,
      secureFileOptions,
    );
  }
  decodeCanonicalCandidateId(candidateId);
  const matches = (await listApplyJournals({ projectRoot, env, secureFileOptions }))
    .filter(journal => journal.candidateId === candidateId);
  if (matches.length === 0) {
    throw journalError(
      'ERR_RESTORE_JOURNAL_MISSING',
      'restore apply journal is missing',
    );
  }
  if (matches.length > 1) {
    throw invalid('restore candidate has more than one apply journal');
  }
  return matches[0];
}
