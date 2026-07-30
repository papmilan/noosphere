import {
  createHash,
  randomBytes as cryptoRandomBytes,
  randomUUID as cryptoRandomUUID,
} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  assertContainedChain,
  ensureRealDirectoryPath,
  readBoundedRegularFile,
  writeOwnerOnlyFileExclusive,
} from '../../secure-fs.js';
import { TrustStoreError, canonicalize } from '../../trust-store-internal.js';
import {
  AUTH_DOMAINS,
  sealRecord,
  verifyRecord,
} from '../authenticated-records.js';
import { createFormatV2Store } from '../trust-format-v2.js';
import { decodeCanonicalCandidateId } from './cli.js';
import {
  CONFIRMATION_TTL_MS,
  RESTORE_RECORD_BYTES,
  RESTORE_SLOTS,
} from './constants.js';
import {
  readCandidateState,
  showRestoreCandidate,
} from './candidate-store.js';
import {
  CONFIRMATION_TRANSITIONS,
  createStateMachine,
  readStateMachine,
  transitionStateMachine,
} from './state-machine.js';

const UTF8 = new TextDecoder('utf-8', { fatal: true });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const IDENTITY = /^sha256:[0-9a-f]{64}$/;
const CONTEXT_FIELDS = new Set([
  'candidateId',
  'candidatePayloadHash',
  'contextId',
  'destination',
  'domain',
  'expiresAt',
  'issuedAt',
  'mac',
  'machineKeyIdentity',
  'manifest',
  'nonce',
  'projectIdentityDigest',
  'schema',
  'slot',
  'version',
]);

function restoreError(code, message) {
  return new TrustStoreError(code, message);
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function exactFields(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.size &&
    Object.keys(value).every(key => fields.has(key));
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function validDestination(value) {
  return exactFields(value, value?.state === 'absent'
    ? new Set(['state'])
    : new Set(['rawHash', 'state'])) &&
    (value.state === 'absent' ||
      (value.state === 'present' && HASH.test(value.rawHash)));
}

function validManifest(value) {
  if (!exactFields(value, new Set(['generation', 'state'])) ||
      !['approved', 'revoked', 'pristine-unapproved'].includes(value.state)) {
    return false;
  }
  if (value.state === 'pristine-unapproved') {
    return exactFields(value.generation, new Set(['state'])) &&
      value.generation.state === 'no-manifest';
  }
  return exactFields(value.generation, new Set(['state', 'value'])) &&
    value.generation.state === 'present' &&
    Number.isInteger(value.generation.value) &&
    value.generation.value >= 1;
}

function confirmationPaths(store, binding, contextId) {
  const root = store.pathFor(binding, path.join('restore', 'confirmations'));
  const directory = path.join(root, contextId);
  return Object.freeze({
    root,
    directory,
    context: path.join(directory, 'context.json'),
  });
}

function confirmationStateExpected(binding, context) {
  return Object.freeze({
    domain: AUTH_DOMAINS.restoreConfirmation,
    entityKind: 'confirmation',
    entityId: context.contextId,
    projectIdentityDigest: context.projectIdentityDigest,
    keyId: binding.keyId,
  });
}

function validateContext(context, { contextId, binding, identityDigest }) {
  if (!exactFields(context, CONTEXT_FIELDS) ||
      context.domain !== AUTH_DOMAINS.restoreConfirmation ||
      context.schema !== 'noosphere.restore-confirmation-context' ||
      context.version !== 1 ||
      context.contextId !== contextId ||
      !UUID.test(context.contextId) ||
      !decodeCandidate(context.candidateId) ||
      !HASH.test(context.candidatePayloadHash) ||
      !Object.hasOwn(RESTORE_SLOTS, context.slot) ||
      !IDENTITY.test(context.projectIdentityDigest) ||
      context.projectIdentityDigest !== identityDigest ||
      context.machineKeyIdentity !== binding.keyId ||
      !HASH.test(context.machineKeyIdentity) ||
      !HASH.test(context.nonce) ||
      !validDestination(context.destination) ||
      !validManifest(context.manifest) ||
      !canonicalTimestamp(context.issuedAt) ||
      !canonicalTimestamp(context.expiresAt) ||
      new Date(context.expiresAt).getTime() -
        new Date(context.issuedAt).getTime() !== CONFIRMATION_TTL_MS) {
    throw restoreError(
      'ERR_RESTORE_CONFIRMATION_INVALID',
      'restore confirmation context is invalid',
    );
  }
}

function decodeCandidate(candidateId) {
  try {
    decodeCanonicalCandidateId(candidateId);
    return true;
  } catch {
    return false;
  }
}

async function readCanonicalContext(file) {
  let bytes;
  try {
    bytes = await readBoundedRegularFile(file, {
      maxBytes: RESTORE_RECORD_BYTES,
    });
  } catch (error) {
    throw restoreError(
      'ERR_RESTORE_CONFIRMATION_INVALID',
      `restore confirmation context is unsafe: ${error.code ?? 'invalid'}`,
    );
  }
  if (bytes === null) {
    throw restoreError(
      'ERR_RESTORE_CONFIRMATION_MISSING',
      'restore confirmation context is missing',
    );
  }
  let text;
  let context;
  try {
    text = UTF8.decode(bytes);
    context = JSON.parse(text);
  } catch {
    throw restoreError(
      'ERR_RESTORE_CONFIRMATION_INVALID',
      'restore confirmation context is malformed',
    );
  }
  if (text !== canonicalize(context)) {
    throw restoreError(
      'ERR_RESTORE_CONFIRMATION_INVALID',
      'restore confirmation context is not canonical',
    );
  }
  return context;
}

function observedBindings(context) {
  return Object.freeze({
    candidateId: context.candidateId,
    candidatePayloadHash: context.candidatePayloadHash,
    slot: context.slot,
    destination: context.destination,
    manifest: context.manifest,
    projectIdentityDigest: context.projectIdentityDigest,
    machineKeyIdentity: context.machineKeyIdentity,
  });
}

export function confirmationPhrase(context) {
  const immutable = { ...context };
  delete immutable.state;
  delete immutable.stateSequence;
  delete immutable.transactionId;
  delete immutable.stateReason;
  return `apply ${context.candidateId} ${hash(canonicalize(immutable))}`;
}

export async function issueConfirmation({
  projectRoot,
  env = process.env,
  secureFileOptions = {},
  candidateId,
  destination,
  manifest,
  now = () => new Date(),
  randomUUID = cryptoRandomUUID,
  randomBytes = cryptoRandomBytes,
} = {}) {
  decodeCanonicalCandidateId(candidateId);
  if (!validDestination(destination) || !validManifest(manifest)) {
    throw restoreError(
      'ERR_RESTORE_CONFIRMATION_INVALID',
      'restore confirmation bindings are invalid',
    );
  }
  const candidate = await showRestoreCandidate({
    projectRoot,
    env,
    secureFileOptions,
    candidateId,
  });
  const candidateState = await readCandidateState({
    projectRoot,
    env,
    secureFileOptions,
    candidateId,
  });
  if (candidateState.state !== 'active') {
    throw restoreError(
      'ERR_RESTORE_CANDIDATE_UNAVAILABLE',
      'restore candidate is not active',
    );
  }
  const store = createFormatV2Store({ env, secureFileOptions });
  const binding = await store.readProjectBinding(projectRoot);
  const key = await store.ensureMachineKey();
  const identityDigest = await store.canonicalProjectIdentityDigest(projectRoot);
  const observedNow = now();
  if (!(observedNow instanceof Date) ||
      Number.isNaN(observedNow.getTime())) {
    throw restoreError(
      'ERR_RESTORE_CONFIRMATION_INVALID',
      'restore confirmation clock is invalid',
    );
  }
  const root = store.pathFor(binding, path.join('restore', 'confirmations'));
  await ensureRealDirectoryPath(root);
  for (let collision = 0; collision < 128; collision += 1) {
    const contextId = randomUUID();
    if (!UUID.test(contextId)) {
      throw restoreError(
        'ERR_RESTORE_CONFIRMATION_INVALID',
        'restore confirmation ID is invalid',
      );
    }
    const paths = confirmationPaths(store, binding, contextId);
    const nonce = Buffer.from(randomBytes(32));
    if (nonce.length !== 32) {
      throw restoreError(
        'ERR_RESTORE_CONFIRMATION_INVALID',
        'restore confirmation nonce must contain 256 bits',
      );
    }
    try {
      await fs.mkdir(paths.directory, { mode: 0o700 });
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw restoreError(
        'ERR_RESTORE_CONFIRMATION_INVALID',
        `restore confirmation directory is unsafe: ${error.code ?? 'invalid'}`,
      );
    }
    const fields = {
      domain: AUTH_DOMAINS.restoreConfirmation,
      schema: 'noosphere.restore-confirmation-context',
      version: 1,
      contextId,
      candidateId,
      candidatePayloadHash: candidate.payloadHash,
      destination,
      slot: candidate.slot,
      projectIdentityDigest: identityDigest,
      manifest,
      machineKeyIdentity: binding.keyId,
      nonce: nonce.toString('hex'),
      issuedAt: observedNow.toISOString(),
      expiresAt: new Date(
        observedNow.getTime() + CONFIRMATION_TTL_MS,
      ).toISOString(),
    };
    const context = sealRecord(
      key,
      AUTH_DOMAINS.restoreConfirmation,
      fields,
    );
    try {
      await writeOwnerOnlyFileExclusive(
        paths.context,
        canonicalize(context),
        secureFileOptions,
      );
      await createStateMachine({
        root: paths.directory,
        key,
        expected: confirmationStateExpected(binding, context),
        initialState: 'issued',
        metadata: { contextId },
        now: observedNow,
        secureFileOptions,
      });
      return readConfirmation({
        projectRoot,
        env,
        secureFileOptions,
        contextId,
      });
    } catch (error) {
      await fs.rm(paths.directory, { recursive: true, force: true })
        .catch(() => undefined);
      throw error;
    }
  }
  throw restoreError(
    'ERR_RESTORE_CONFIRMATION_COLLISION',
    'restore confirmation ID collision limit exceeded',
  );
}

export async function readConfirmation({
  projectRoot,
  env = process.env,
  secureFileOptions = {},
  contextId,
} = {}) {
  if (!UUID.test(contextId)) {
    throw restoreError(
      'ERR_RESTORE_CONFIRMATION_INVALID',
      'restore confirmation ID is invalid',
    );
  }
  const store = createFormatV2Store({ env, secureFileOptions });
  const binding = await store.readProjectBinding(projectRoot);
  const identityDigest = await store.canonicalProjectIdentityDigest(projectRoot);
  const paths = confirmationPaths(store, binding, contextId);
  try {
    const safe = await assertContainedChain(
      store.pathFor(binding, ''),
      paths.directory,
    );
    if (safe === null) {
      throw restoreError(
        'ERR_RESTORE_CONFIRMATION_MISSING',
        'restore confirmation context is missing',
      );
    }
  } catch (error) {
    if (error instanceof TrustStoreError) throw error;
    if (error.code === 'ENOENT') {
      throw restoreError(
        'ERR_RESTORE_CONFIRMATION_MISSING',
        'restore confirmation context is missing',
      );
    }
    throw restoreError(
      'ERR_RESTORE_CONFIRMATION_INVALID',
      `restore confirmation path is unsafe: ${error.code ?? 'invalid'}`,
    );
  }
  const context = await readCanonicalContext(paths.context);
  validateContext(context, { contextId, binding, identityDigest });
  const key = await store.ensureMachineKey();
  if (!verifyRecord(key, AUTH_DOMAINS.restoreConfirmation, context)) {
    throw restoreError(
      'ERR_RESTORE_CONFIRMATION_INVALID',
      'restore confirmation context MAC does not verify',
    );
  }
  const state = await readStateMachine({
    root: paths.directory,
    key,
    expected: confirmationStateExpected(binding, context),
    transitions: CONFIRMATION_TRANSITIONS,
    secureFileOptions,
  });
  return Object.freeze({
    ...context,
    state: state.state,
    stateSequence: state.sequence,
    stateEventHash: state.eventHash,
    transactionId: state.transactionId,
    stateReason: state.reason,
  });
}

async function transitionConfirmation({
  projectRoot,
  env,
  secureFileOptions,
  context,
  to,
  metadata,
  now,
}) {
  const store = createFormatV2Store({ env, secureFileOptions });
  const binding = await store.readProjectBinding(projectRoot);
  return transitionStateMachine({
    root: confirmationPaths(store, binding, context.contextId).directory,
    key: await store.ensureMachineKey(),
    expected: confirmationStateExpected(binding, context),
    transitions: CONFIRMATION_TRANSITIONS,
    to,
    code: context.state === 'spent'
      ? 'ERR_RESTORE_CONFIRMATION_SPENT'
      : 'ERR_RESTORE_CONFIRMATION_TRANSITION',
    metadata,
    now,
    secureFileOptions,
  });
}

export async function confirmContext({
  projectRoot,
  env = process.env,
  secureFileOptions = {},
  contextId,
  phrase,
  observed,
  now = () => new Date(),
} = {}) {
  const context = await readConfirmation({
    projectRoot,
    env,
    secureFileOptions,
    contextId,
  });
  if (context.state === 'spent') {
    throw restoreError(
      'ERR_RESTORE_CONFIRMATION_SPENT',
      'restore confirmation context is already spent',
    );
  }
  if (context.state !== 'issued') {
    throw restoreError(
      'ERR_RESTORE_CONFIRMATION_CONFIRMED',
      'restore confirmation context is already confirmed',
    );
  }
  const observedNow = now();
  const spendThenThrow = async (code, message, reason) => {
    await transitionConfirmation({
      projectRoot,
      env,
      secureFileOptions,
      context,
      to: 'spent',
      metadata: { contextId, reason },
      now: observedNow,
    });
    throw restoreError(code, message);
  };
  if (!(observedNow instanceof Date) ||
      Number.isNaN(observedNow.getTime()) ||
      observedNow.getTime() > new Date(context.expiresAt).getTime()) {
    return spendThenThrow(
      'ERR_RESTORE_CONFIRMATION_EXPIRED',
      'restore confirmation context expired',
      'expired',
    );
  }
  if (canonicalize(observed ?? observedBindings(context)) !==
      canonicalize(observedBindings(context))) {
    return spendThenThrow(
      'ERR_RESTORE_CONFIRMATION_CHANGED',
      'restore confirmation bindings changed',
      'changed',
    );
  }
  if (phrase !== confirmationPhrase(context)) {
    return spendThenThrow(
      'restore-declined',
      'restore confirmation was not exact',
      'declined',
    );
  }
  await transitionConfirmation({
    projectRoot,
    env,
    secureFileOptions,
    context,
    to: 'confirmed',
    metadata: { contextId },
    now: observedNow,
  });
  return readConfirmation({
    projectRoot,
    env,
    secureFileOptions,
    contextId,
  });
}

export async function spendContext({
  projectRoot,
  env = process.env,
  secureFileOptions = {},
  contextId,
  transactionId = null,
  reason = null,
  now = () => new Date(),
} = {}) {
  const context = await readConfirmation({
    projectRoot,
    env,
    secureFileOptions,
    contextId,
  });
  if (context.state === 'spent') {
    throw restoreError(
      'ERR_RESTORE_CONFIRMATION_SPENT',
      'restore confirmation context is already spent',
    );
  }
  if (context.state === 'confirmed' && !UUID.test(transactionId)) {
    throw restoreError(
      'ERR_RESTORE_CONFIRMATION_TRANSITION',
      'confirmed restore context requires one transaction ID',
    );
  }
  await transitionConfirmation({
    projectRoot,
    env,
    secureFileOptions,
    context,
    to: 'spent',
    metadata: {
      contextId,
      transactionId,
      reason: reason ?? (context.state === 'confirmed' ? 'bound' : 'abandoned'),
    },
    now: now(),
  });
  return readConfirmation({
    projectRoot,
    env,
    secureFileOptions,
    contextId,
  });
}
