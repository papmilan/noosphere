import { randomUUID } from 'node:crypto';
import path from 'node:path';

import * as defaultSecureFs from '../../secure-fs.js';
import { resolveSlotSource } from '../../slot-sources.js';
import { isSlotAuthoritative } from '../../trust-store.js';
import { TrustStoreError, canonicalize } from '../../trust-store-internal.js';
import {
  assertInteractiveStreams,
  readExactConfirmation,
} from '../exact-confirmation.js';
import { createFormatV2Store } from '../trust-format-v2.js';
import {
  consumeCandidate,
  markApplyInProgress,
  readCandidateState,
  showRestoreCandidate,
} from './candidate-store.js';
import {
  confirmContext,
  confirmationPhrase,
  issueConfirmation,
  readConfirmation,
  spendContext,
} from './confirmation-store.js';
import {
  AUTHORITY_PAYLOAD_BYTES,
  RESTORE_CONFIRMATION_BYTES,
  RESTORE_SLOTS,
} from './constants.js';

function restoreError(code, message) {
  return new TrustStoreError(code, message);
}

function fixedDestination(projectRoot, slot) {
  const relative = RESTORE_SLOTS[slot]?.destination;
  if (!relative) {
    throw restoreError(
      'ERR_RESTORE_FINAL_BARRIER',
      'restore slot has no fixed destination',
    );
  }
  return path.join(projectRoot, ...relative.split('/'));
}

function destinationBinding(observed) {
  return observed.state === 'absent'
    ? Object.freeze({ state: 'absent' })
    : Object.freeze({
        state: 'present',
        rawHash: observed.contentHash,
      });
}

async function manifestBinding(store, binding, slot) {
  const state = await store.classifySlot({ binding, slot });
  if (state.state === 'pristine-unapproved') {
    return Object.freeze({
      state: 'pristine-unapproved',
      generation: Object.freeze({ state: 'no-manifest' }),
    });
  }
  if (state.state !== 'approved' && state.state !== 'revoked') {
    throw restoreError(
      'ERR_RESTORE_FINAL_BARRIER',
      'restore manifest state is invalid',
    );
  }
  return Object.freeze({
    state: state.state,
    generation: Object.freeze({
      state: 'present',
      value: state.generation,
    }),
  });
}

async function observeForConfirmation({
  projectRoot,
  slot,
  env,
  secureFileOptions,
  secureFs,
}) {
  const store = createFormatV2Store({ env, secureFileOptions });
  const binding = await store.readProjectBinding(projectRoot);
  const destination = await secureFs.inspectOwnerOnlyDestination(
    fixedDestination(projectRoot, slot),
    {
      root: projectRoot,
      maxBytes: AUTHORITY_PAYLOAD_BYTES,
    },
  );
  return Object.freeze({
    destination: destinationBinding(destination),
    manifest: await manifestBinding(store, binding, slot),
  });
}

async function runFinalBarrier({
  projectRoot,
  env,
  secureFileOptions,
  secureFs,
  candidateId,
  contextId,
  transactionId,
  onBarrier,
}) {
  const store = createFormatV2Store({ env, secureFileOptions });
  const binding = await store.readProjectBinding(projectRoot);
  const identityDigest = await store.canonicalProjectIdentityDigest(projectRoot);
  const lock = await store.inspectLock(binding, (
    await readConfirmation({
      projectRoot,
      env,
      secureFileOptions,
      contextId,
    })
  ).slot);
  const context = await readConfirmation({
    projectRoot,
    env,
    secureFileOptions,
    contextId,
  });
  if (!lock || lock.transactionId !== transactionId ||
      context.state !== 'confirmed') {
    throw restoreError(
      'ERR_RESTORE_FINAL_BARRIER',
      'restore slot lock or confirmation state is invalid',
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
  const destinationPath = fixedDestination(projectRoot, context.slot);
  const observedDestination = await secureFs.inspectOwnerOnlyDestination(
    destinationPath,
    {
      root: projectRoot,
      maxBytes: AUTHORITY_PAYLOAD_BYTES,
    },
  );
  const observedManifest = await manifestBinding(store, binding, context.slot);
  const expected = Object.freeze({
    candidateId: context.candidateId,
    candidatePayloadHash: context.candidatePayloadHash,
    destination: context.destination,
    machineKeyIdentity: context.machineKeyIdentity,
    manifest: context.manifest,
    projectIdentityDigest: context.projectIdentityDigest,
    slot: context.slot,
  });
  const observed = Object.freeze({
    candidateId: candidate.candidateId,
    candidatePayloadHash: candidate.payloadHash,
    destination: destinationBinding(observedDestination),
    machineKeyIdentity: binding.keyId,
    manifest: observedManifest,
    projectIdentityDigest: identityDigest,
    slot: candidate.slot,
  });
  if (candidateState.state !== 'active' ||
      context.candidateId !== candidateId ||
      canonicalize(observed) !== canonicalize(expected)) {
    throw restoreError(
      'ERR_RESTORE_FINAL_BARRIER',
      'restore final state observation changed after confirmation',
    );
  }
  if (onBarrier) await onBarrier(Object.freeze({
    binding,
    candidate,
    context,
    destination: observedDestination,
    manifest: observedManifest,
    transactionId,
  }));
  return Object.freeze({
    binding,
    candidate,
    context,
    destination: observedDestination,
    destinationPath,
    manifest: observedManifest,
  });
}

async function ttyApplyConfirmation(context, {
  input,
  output,
}) {
  const phrase = confirmationPhrase(context);
  output.write([
    '',
    `Candidate:        ${context.candidateId}`,
    `Payload hash:     ${context.candidatePayloadHash}`,
    `Slot:             ${context.slot}`,
    `Project identity: ${context.projectIdentityDigest}`,
    `Destination:      ${canonicalize(context.destination)}`,
    `Manifest:         ${canonicalize(context.manifest)}`,
    `Machine key:      ${context.machineKeyIdentity}`,
    `Context:          ${context.contextId}`,
    '',
    'The candidate remains untrusted. Applying it replaces only the fixed',
    'project file and does not approve, revoke, or rewrite trust history.',
    '',
    `Type "${phrase}" to apply, anything else to abort.`,
    '',
  ].join('\n'));
  return readExactConfirmation({
    input,
    output,
    phrase,
    maxBytes: RESTORE_CONFIRMATION_BYTES,
    ttyCode: 'restore-apply-requires-tty',
    ttyMessage: 'restore apply requires an interactive terminal',
    tooLongCode: 'restore-input-too-long',
    tooLongMessage: 'restore confirmation exceeds 256 bytes',
  });
}

export async function applyRestoreCandidate({
  projectRoot,
  candidateId,
  env = process.env,
  secureFileOptions = {},
  input = process.stdin,
  output = process.stdout,
  confirm,
  afterConfirmation,
  onBarrier,
  secureFs = defaultSecureFs,
  now = () => new Date(),
  createTransactionId = randomUUID,
} = {}) {
  if (!confirm) {
    assertInteractiveStreams({
      input,
      output,
      code: 'restore-apply-requires-tty',
      message: 'restore apply requires an interactive terminal',
    });
  }
  const candidate = await showRestoreCandidate({
    projectRoot,
    env,
    secureFileOptions,
    candidateId,
  });
  if (candidate.candidateState.state !== 'active') {
    throw restoreError(
      'ERR_RESTORE_CANDIDATE_UNAVAILABLE',
      'restore candidate is not active',
    );
  }
  let initial;
  try {
    initial = await observeForConfirmation({
      projectRoot,
      slot: candidate.slot,
      env,
      secureFileOptions,
      secureFs,
    });
  } catch (error) {
    if (error instanceof TrustStoreError) throw error;
    throw restoreError(
      'ERR_RESTORE_FINAL_BARRIER',
      `restore destination validation failed: ${error.code ?? error.message}`,
    );
  }
  const issued = await issueConfirmation({
    projectRoot,
    env,
    secureFileOptions,
    candidateId,
    destination: initial.destination,
    manifest: initial.manifest,
    now,
  });
  let accepted;
  try {
    accepted = await (confirm ?? (context =>
      ttyApplyConfirmation(context, { input, output })))(issued);
  } catch (error) {
    await spendContext({
      projectRoot,
      env,
      secureFileOptions,
      contextId: issued.contextId,
      reason: 'input-failed',
      now,
    }).catch(() => undefined);
    throw error;
  }
  const confirmed = await confirmContext({
    projectRoot,
    env,
    secureFileOptions,
    contextId: issued.contextId,
    phrase: accepted === true ? confirmationPhrase(issued) : '',
    now,
  });
  const transactionId = createTransactionId();
  const store = createFormatV2Store({ env, secureFileOptions });
  const binding = await store.readProjectBinding(projectRoot);
  let lock;
  let prepared = null;
  let candidateInProgress = false;
  let destinationReplaced = false;
  try {
    if (afterConfirmation) await afterConfirmation(confirmed);
    lock = await store.acquireLock(binding, candidate.slot, transactionId);
    const barrier = await runFinalBarrier({
      projectRoot,
      env,
      secureFileOptions,
      secureFs,
      candidateId,
      contextId: confirmed.contextId,
      transactionId,
      onBarrier,
    });
    await spendContext({
      projectRoot,
      env,
      secureFileOptions,
      contextId: confirmed.contextId,
      transactionId,
      now,
    });
    await markApplyInProgress({
      projectRoot,
      env,
      secureFileOptions,
      candidateId,
      contextId: confirmed.contextId,
      transactionId,
      now,
    });
    candidateInProgress = true;
    prepared = await secureFs.prepareOwnerOnlyReplacement(
      barrier.destinationPath,
      barrier.candidate.content,
      {
        root: projectRoot,
        maxBytes: AUTHORITY_PAYLOAD_BYTES,
        expectedDestination: barrier.destination,
      },
    );
    try {
      await secureFs.commitOwnerOnlyReplacement(prepared, {
        root: projectRoot,
        maxBytes: AUTHORITY_PAYLOAD_BYTES,
      });
      destinationReplaced = true;
    } catch (error) {
      if (error.destinationReplaced === true) destinationReplaced = true;
      throw error;
    }
    const live = await resolveSlotSource(projectRoot, candidate.slot);
    const authoritative = await isSlotAuthoritative({
      projectRoot,
      slot: candidate.slot,
      rawBytes: live.bytes,
      env,
      secureFileOptions,
    });
    return Object.freeze({
      status: 'destination-replaced',
      authoritative,
      candidateId,
      contextId: confirmed.contextId,
      transactionId,
    });
  } catch (error) {
    if (prepared && !destinationReplaced) {
      await secureFs.discardOwnerOnlyReplacement(prepared, {
        root: projectRoot,
      }).catch(() => undefined);
    }
    if (candidateInProgress && !destinationReplaced) {
      await consumeCandidate({
        projectRoot,
        env,
        secureFileOptions,
        candidateId,
        transactionId,
        outcome: 'failed',
        now,
      }).catch(() => undefined);
    } else if (confirmed.state === 'confirmed' && !candidateInProgress) {
      await spendContext({
        projectRoot,
        env,
        secureFileOptions,
        contextId: confirmed.contextId,
        transactionId,
        reason: 'apply-failed',
        now,
      }).catch(() => undefined);
    }
    if (String(error.code ?? '').startsWith('ERR_RESTORE_') ||
        error instanceof TrustStoreError) {
      throw error;
    }
    const wrapped = restoreError(
      'ERR_RESTORE_APPLY_FAILED',
      `restore apply failed: ${error.code ?? error.message}`,
    );
    if (destinationReplaced) wrapped.destinationReplaced = true;
    throw wrapped;
  } finally {
    if (lock) await lock.release();
  }
}
