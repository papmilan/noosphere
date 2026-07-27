import fs from 'node:fs/promises';
import path from 'node:path';

import * as defaultSecureFs from '../../secure-fs.js';
import { resolveSlotSource } from '../../slot-sources.js';
import { isSlotAuthoritative } from '../../trust-store.js';
import { TrustStoreError } from '../../trust-store-internal.js';
import { createFormatV2Store } from '../trust-format-v2.js';
import {
  appendApplyJournalState,
  listApplyJournals,
  readApplyJournal,
} from './apply-journal.js';
import {
  consumeCandidate,
  showRestoreCandidate,
} from './candidate-store.js';
import { readConfirmation } from './confirmation-store.js';
import { AUTHORITY_PAYLOAD_BYTES } from './constants.js';
import {
  commitConsumedMarker,
  commitRestoreReceipt,
  readConsumedMarker,
  readRestoreReceipt,
} from './receipt-store.js';

const OWNER_INTERVENTION = 'ERR_RESTORE_OWNER_INTERVENTION_REQUIRED';

function ownerIntervention(message) {
  return new TrustStoreError(OWNER_INTERVENTION, message);
}

function requireEvidence(condition, message) {
  if (!condition) throw ownerIntervention(message);
}

/**
 * Authenticates the crashed transaction's temporary file against the journal
 * before removing it. Destination bytes never select a recovery branch, and a
 * temporary file that does not match the authenticated payload is left in place
 * for the owner.
 */
async function discardTemporary(journal, { projectRoot, secureFs }) {
  const temporaryPath = path.join(
    projectRoot,
    ...journal.temporaryPath.split('/'),
  );
  let observed;
  try {
    observed = await secureFs.inspectOwnerOnlyDestination(temporaryPath, {
      root: projectRoot,
      maxBytes: AUTHORITY_PAYLOAD_BYTES,
    });
  } catch (error) {
    if (error.code === 'state-destination-parent-missing') return false;
    throw ownerIntervention(
      `restore apply temporary file is unsafe: ${error.code ?? 'invalid'}`,
    );
  }
  if (observed.state === 'absent') return false;
  requireEvidence(
    observed.contentHash === journal.destinationAfterHash,
    'restore apply temporary file does not match the authenticated payload',
  );
  await fs.rm(temporaryPath, { force: false });
  return true;
}

async function ensureCandidateConsumed(journal, outcome, input) {
  const candidate = await showRestoreCandidate({
    projectRoot: input.projectRoot,
    env: input.env,
    secureFileOptions: input.secureFileOptions,
    candidateId: journal.candidateId,
  });
  const state = candidate.candidateState;
  if (state.state === 'consumed') {
    requireEvidence(
      state.transactionId === journal.transactionId && state.outcome === outcome,
      'restore candidate was consumed by a conflicting transaction or outcome',
    );
    return;
  }
  requireEvidence(
    state.state === 'apply-in-progress' &&
      state.transactionId === journal.transactionId,
    'restore candidate is not owned by the recovering transaction',
  );
  await consumeCandidate({
    projectRoot: input.projectRoot,
    env: input.env,
    secureFileOptions: input.secureFileOptions,
    candidateId: journal.candidateId,
    transactionId: journal.transactionId,
    outcome,
    now: input.now,
  });
}

async function assertCompleteChain(journal, input) {
  const store = createFormatV2Store({
    env: input.env,
    secureFileOptions: input.secureFileOptions,
  });
  const binding = await store.readProjectBinding(input.projectRoot);
  const identityDigest =
    await store.canonicalProjectIdentityDigest(input.projectRoot);
  requireEvidence(
    journal.projectIdentityDigest === identityDigest &&
      journal.keyId === binding.keyId &&
      journal.bindingId === binding.projectIdentity,
    'restore apply journal is not bound to this project identity',
  );
  const candidate = await showRestoreCandidate({
    projectRoot: input.projectRoot,
    env: input.env,
    secureFileOptions: input.secureFileOptions,
    candidateId: journal.candidateId,
  });
  requireEvidence(
    candidate.slot === journal.slot &&
      candidate.payloadHash === journal.candidatePayloadHash &&
      candidate.payloadHash === journal.destinationAfterHash &&
      candidate.projectIdentityDigest === journal.projectIdentityDigest,
    'restore candidate does not match its authenticated apply journal',
  );
  const confirmation = await readConfirmation({
    projectRoot: input.projectRoot,
    env: input.env,
    secureFileOptions: input.secureFileOptions,
    contextId: journal.contextId,
  });
  requireEvidence(
    confirmation.state === 'spent' &&
      confirmation.transactionId === journal.transactionId &&
      confirmation.candidateId === journal.candidateId &&
      confirmation.candidatePayloadHash === journal.candidatePayloadHash &&
      confirmation.stateEventHash === journal.confirmationEventHash,
    'restore confirmation was not spent by the recovering transaction',
  );
  // Fail closed on any present slot lock: Phase 4A/4B never auto-reclaim a lock,
  // so a lock left by a killed process is owner-intervention territory.
  let lock;
  try {
    lock = await store.inspectLock(binding, journal.slot);
  } catch (error) {
    throw ownerIntervention(`restore slot lock is unusable: ${error.code ?? 'invalid'}`);
  }
  requireEvidence(lock === null, 'restore slot lock is still held');
  return { store, binding };
}

async function advance(journal, input, { store, binding }) {
  const destinationPath = path.join(
    input.projectRoot,
    ...journal.destination.split('/'),
  );
  const append = (to, outcome = null) => appendApplyJournalState({
    projectRoot: input.projectRoot,
    env: input.env,
    secureFileOptions: input.secureFileOptions,
    transactionId: journal.transactionId,
    to,
    outcome,
    now: input.now,
  });

  let state = journal.state;
  if (state === 'prepared' || state === 'temporary-written') {
    await discardTemporary(journal, input);
    await ensureCandidateConsumed(journal, 'failed', input);
    await append('complete', 'failed');
    return 'discarded';
  }

  if (state === 'destination-replaced') {
    let observed;
    try {
      observed = await input.secureFs.inspectOwnerOnlyDestination(destinationPath, {
        root: input.projectRoot,
        maxBytes: AUTHORITY_PAYLOAD_BYTES,
      });
    } catch (error) {
      throw ownerIntervention(
        `restore destination is unsafe: ${error.code ?? 'invalid'}`,
      );
    }
    requireEvidence(
      observed.state === 'present' &&
        observed.contentHash === journal.destinationAfterHash,
      'restore destination bytes do not match the authenticated replacement',
    );
    const live = await resolveSlotSource(input.projectRoot, journal.slot);
    const authoritative = await isSlotAuthoritative({
      projectRoot: input.projectRoot,
      slot: journal.slot,
      rawBytes: live.bytes,
      env: input.env,
      secureFileOptions: input.secureFileOptions,
    });
    await commitRestoreReceipt({
      projectRoot: input.projectRoot,
      env: input.env,
      secureFileOptions: input.secureFileOptions,
      receiptId: journal.receiptId,
      transactionId: journal.transactionId,
      contextId: journal.contextId,
      candidateId: journal.candidateId,
      candidatePayloadHash: journal.candidatePayloadHash,
      destinationHash: journal.destinationAfterHash,
      slot: journal.slot,
      outcome: 'applied',
      authoritative,
      now: input.now,
    });
    await append('receipt-committed');
    state = 'receipt-committed';
  }

  if (state === 'receipt-committed') {
    await readRestoreReceipt({
      projectRoot: input.projectRoot,
      env: input.env,
      secureFileOptions: input.secureFileOptions,
      receiptId: journal.receiptId,
    });
    await commitConsumedMarker({
      projectRoot: input.projectRoot,
      env: input.env,
      secureFileOptions: input.secureFileOptions,
      transactionId: journal.transactionId,
      contextId: journal.contextId,
      candidateId: journal.candidateId,
      candidatePayloadHash: journal.candidatePayloadHash,
      slot: journal.slot,
      outcome: 'applied',
      receiptId: journal.receiptId,
      now: input.now,
    });
    await ensureCandidateConsumed(journal, 'applied', input);
    await append('consumed-marker-committed');
    state = 'consumed-marker-committed';
  }

  await readConsumedMarker({
    projectRoot: input.projectRoot,
    env: input.env,
    secureFileOptions: input.secureFileOptions,
    candidateId: journal.candidateId,
  });
  await append('complete', 'applied');
  return 'applied';
}

async function recoverOne(journal, input) {
  const context = await assertCompleteChain(journal, input);
  const { store, binding } = context;
  const lock = await store.acquireLock(binding, journal.slot);
  try {
    // Re-read under the lock: nothing may advance on an observation taken
    // before mutual exclusion was held.
    const current = await readApplyJournal({
      projectRoot: input.projectRoot,
      env: input.env,
      secureFileOptions: input.secureFileOptions,
      transactionId: journal.transactionId,
    });
    if (current.state === 'complete') return 'complete';
    requireEvidence(
      current.state === journal.state &&
        current.stateEventHash === journal.stateEventHash,
      'restore apply journal advanced while recovery was starting',
    );
    return await advance(current, input, context);
  } finally {
    await lock.release().catch(() => undefined);
  }
}

export async function recoverRestoreTransactions({
  projectRoot,
  env = process.env,
  secureFileOptions = {},
  secureFs = defaultSecureFs,
  now = () => new Date(),
} = {}) {
  const input = { projectRoot, env, secureFileOptions, secureFs, now };
  const journals = await listApplyJournals({
    projectRoot,
    env,
    secureFileOptions,
  });
  const recovered = [];
  for (const journal of journals) {
    if (journal.state === 'complete') {
      recovered.push(Object.freeze({
        transactionId: journal.transactionId,
        status: 'complete',
      }));
      continue;
    }
    let status;
    try {
      status = await recoverOne(journal, input);
    } catch (error) {
      if (error.code === OWNER_INTERVENTION) throw error;
      // Fail closed: conflicting, missing, unsafe, or unauthenticated evidence
      // always surfaces as owner intervention rather than a partial repair.
      throw ownerIntervention(
        `restore recovery could not authenticate transaction ${journal.transactionId}: ${error.code ?? error.message}`,
      );
    }
    recovered.push(Object.freeze({
      transactionId: journal.transactionId,
      status,
    }));
  }
  return Object.freeze(recovered);
}
