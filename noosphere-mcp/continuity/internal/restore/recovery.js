import fs from 'node:fs/promises';
import path from 'node:path';

import * as defaultSecureFs from '../../secure-fs.js';
import { resolveSlotSource } from '../../slot-sources.js';
import { isSlotAuthoritative } from '../../trust-store.js';
import { TrustStoreError, canonicalize } from '../../trust-store-internal.js';
import { createFormatV2Store } from '../trust-format-v2.js';
import {
  appendApplyJournalState,
  listApplyJournals,
  readApplyJournal,
} from './apply-journal.js';
import {
  consumeCandidate,
  listApplyInProgressCandidates,
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

// Diagnostic only. Recovery does not use liveness to decide whether a present
// lock may be removed; every present lock requires owner intervention.
export function classifyLockLiveness(lock) {
  if (!Number.isInteger(lock?.pid) || lock.pid <= 0) return 'ambiguous';
  try {
    process.kill(lock.pid, 0);
    return 'live';
  } catch (error) {
    if (error?.code === 'ESRCH') return 'abandoned';
    if (error?.code === 'EPERM') return 'live';
    return 'ambiguous';
  }
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

/** Whether the transaction's deterministic temporary file still exists. */
async function temporaryExists(journal, { projectRoot }) {
  const temporaryPath = path.join(projectRoot, ...journal.temporaryPath.split('/'));
  try {
    await fs.lstat(temporaryPath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw ownerIntervention(`restore apply temporary file is unreadable: ${error.code ?? 'invalid'}`);
  }
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

/** The manifest binding in exactly the shape the apply journal recorded. */
async function currentManifestBinding(store, binding, slot) {
  const state = await store.classifySlot({ binding, slot });
  if (state.state === 'pristine-unapproved') {
    return { state: 'pristine-unapproved', generation: { state: 'no-manifest' } };
  }
  if (state.state !== 'approved' && state.state !== 'revoked') {
    throw ownerIntervention('restore manifest state is invalid during recovery');
  }
  return {
    state: state.state,
    generation: { state: 'present', value: state.generation },
  };
}

async function assertCompleteChain(journal, input, {
  heldTransactionId = null,
} = {}) {
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
  // HOSTILE REVIEW, finding C: the recovery barrier must refuse when the
  // manifest has moved since the owner confirmed. Without this, a transaction
  // confirmed against pristine-unapproved state completes after the slot has
  // been approved — the owner authorised a replacement in one authority state
  // and it lands in another.
  const currentManifest = await currentManifestBinding(store, binding, journal.slot);
  requireEvidence(
    canonicalize(currentManifest) === canonicalize(journal.manifest),
    'restore manifest state changed after the owner confirmed',
  );

  const destinationPath = path.join(
    input.projectRoot,
    ...journal.destination.split('/'),
  );
  try {
    await input.secureFs.inspectOwnerOnlyDestination(destinationPath, {
      root: input.projectRoot,
      maxBytes: AUTHORITY_PAYLOAD_BYTES,
    });
  } catch (error) {
    throw ownerIntervention(`restore destination is unsafe: ${error.code ?? 'invalid'}`);
  }

  const receipt = await readRestoreReceipt({
    projectRoot: input.projectRoot,
    env: input.env,
    secureFileOptions: input.secureFileOptions,
    receiptId: journal.receiptId,
    missingAllowed: true,
  });
  const consumed = await readConsumedMarker({
    projectRoot: input.projectRoot,
    env: input.env,
    secureFileOptions: input.secureFileOptions,
    candidateId: journal.candidateId,
    missingAllowed: true,
  });
  if (receipt !== null) {
    requireEvidence(
      receipt.transactionId === journal.transactionId &&
        receipt.contextId === journal.contextId &&
        receipt.candidateId === journal.candidateId &&
        receipt.candidatePayloadHash === journal.candidatePayloadHash &&
        receipt.destinationHash === journal.destinationAfterHash &&
        receipt.slot === journal.slot,
      'restore receipt does not match its authenticated apply journal',
    );
  }
  if (consumed !== null) {
    requireEvidence(
      consumed.transactionId === journal.transactionId &&
        consumed.contextId === journal.contextId &&
        consumed.candidateId === journal.candidateId &&
        consumed.candidatePayloadHash === journal.candidatePayloadHash &&
        consumed.slot === journal.slot,
      'restore consumed marker does not match its authenticated apply journal',
    );
  }
  const candidateState = candidate.candidateState;
  const candidateInProgress =
    candidateState.state === 'apply-in-progress' &&
    candidateState.transactionId === journal.transactionId &&
    candidateState.contextId === journal.contextId;
  const candidateFailed =
    candidateState.state === 'consumed' &&
    candidateState.transactionId === journal.transactionId &&
    candidateState.contextId === journal.contextId &&
    candidateState.outcome === 'failed';
  const candidateApplied =
    candidateState.state === 'consumed' &&
    candidateState.transactionId === journal.transactionId &&
    candidateState.contextId === journal.contextId &&
    candidateState.outcome === 'applied';

  const early = journal.state === 'prepared' ||
    journal.state === 'temporary-written';
  const destinationReplaced = journal.state === 'destination-replaced';
  const receiptCommitted = journal.state === 'receipt-committed';
  const consumedCommitted = journal.state === 'consumed-marker-committed';
  requireEvidence(
    !early || (receipt === null && consumed === null &&
      (candidateInProgress || candidateFailed)),
    'restore candidate or receipt namespace conflicts with the early apply journal state',
  );
  requireEvidence(
    !destinationReplaced || (consumed === null && candidateInProgress),
    'restore candidate or consumed namespace conflicts with the destination-replaced journal state',
  );
  requireEvidence(
    !receiptCommitted || (receipt !== null &&
      (consumed === null
        ? candidateInProgress
        : candidateInProgress || candidateApplied)),
    'restore candidate, receipt, or consumed namespace conflicts with the receipt-committed journal state',
  );
  requireEvidence(
    !consumedCommitted || (receipt !== null && consumed !== null &&
      candidateApplied),
    'restore candidate, receipt, or consumed namespace conflicts with the consumed-marker journal state',
  );

  // Phase 4A lock policy: every present lock is owner-intervention territory.
  // Recovery never decides that a lock is stale and never unlinks one.
  let lock;
  try {
    lock = await store.inspectLock(binding, journal.slot);
  } catch (error) {
    throw ownerIntervention(`restore slot lock is unusable: ${error.code ?? 'invalid'}`);
  }
  if (heldTransactionId === null) {
    requireEvidence(
      lock === null,
      'restore slot lock is present and requires owner intervention',
    );
  } else {
    requireEvidence(
      lock !== null && lock.transactionId === heldTransactionId,
      'restore recovery does not hold the authenticated slot lock',
    );
  }
  const candidateDisposition = candidateInProgress
    ? 'in-progress'
    : candidateFailed
      ? 'failed'
      : candidateApplied
        ? 'applied'
        : 'conflicting';
  return { store, binding, candidateDisposition };
}

async function advance(journal, input, {
  store,
  binding,
  candidateDisposition,
}) {
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
  if ((state === 'prepared' || state === 'temporary-written') &&
      candidateDisposition === 'failed') {
    let observed;
    try {
      observed = await input.secureFs.inspectOwnerOnlyDestination(destinationPath, {
        root: input.projectRoot,
        maxBytes: AUTHORITY_PAYLOAD_BYTES,
      });
    } catch (error) {
      throw ownerIntervention(`restore destination is unsafe: ${error.code ?? 'invalid'}`);
    }
    const matchesBefore = observed.state === 'absent'
      ? journal.destinationBefore.state === 'absent'
      : journal.destinationBefore.state === 'present' &&
        observed.contentHash === journal.destinationBefore.rawHash;
    requireEvidence(
      matchesBefore,
      'restore failed-path destination does not match the authenticated pre-state',
    );
    await discardTemporary(journal, input);
    await ensureCandidateConsumed(journal, 'failed', input);
    await append('complete', 'failed');
    return 'discarded';
  }

  if (state === 'prepared') {
    let observed;
    try {
      observed = await input.secureFs.inspectOwnerOnlyDestination(destinationPath, {
        root: input.projectRoot,
        maxBytes: AUTHORITY_PAYLOAD_BYTES,
      });
    } catch (error) {
      throw ownerIntervention(`restore destination is unsafe: ${error.code ?? 'invalid'}`);
    }
    const matchesBefore = observed.state === 'absent'
      ? journal.destinationBefore.state === 'absent'
      : journal.destinationBefore.state === 'present' &&
        observed.contentHash === journal.destinationBefore.rawHash;
    requireEvidence(
      matchesBefore,
      'restore prepared destination does not match the authenticated pre-state',
    );
    await discardTemporary(journal, input);
    await ensureCandidateConsumed(journal, 'failed', input);
    await append('complete', 'failed');
    return 'discarded';
  }

  if (state === 'temporary-written') {
    let observed;
    try {
      observed = await input.secureFs.inspectOwnerOnlyDestination(destinationPath, {
        root: input.projectRoot,
        maxBytes: AUTHORITY_PAYLOAD_BYTES,
      });
    } catch (error) {
      throw ownerIntervention(`restore destination is unsafe: ${error.code ?? 'invalid'}`);
    }
    const matchesBefore = observed.state === 'absent'
      ? journal.destinationBefore.state === 'absent'
      : journal.destinationBefore.state === 'present' &&
        observed.contentHash === journal.destinationBefore.rawHash;
    const matchesAfter = observed.state === 'present' &&
      observed.contentHash === journal.destinationAfterHash;
    const temporaryPresent = await temporaryExists(journal, input);

    if (matchesAfter && !temporaryPresent) {
      await append('destination-replaced');
      state = 'destination-replaced';
    } else {
      requireEvidence(
        matchesBefore,
        'restore temporary-written destination is neither the authenticated pre-state nor the authenticated replacement',
      );
      await discardTemporary(journal, input);
      await ensureCandidateConsumed(journal, 'failed', input);
      await append('complete', 'failed');
      return 'discarded';
    }
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
  const oriented = await assertCompleteChain(journal, input);
  const { store, binding } = oriented;
  if (input.beforeRecoveryLock) await input.beforeRecoveryLock();
  let lock;
  try {
    lock = await store.acquireLock(binding, journal.slot, journal.transactionId);
  } catch (error) {
    // Another process took the slot between the barrier and the acquire. That
    // process is live by definition, so this is the live-competitor outcome,
    // not a repair opportunity.
    throw ownerIntervention(
      `restore slot lock could not be acquired for recovery: ${error.code ?? 'invalid'}`,
    );
  }
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
    // This is the complete final barrier. The pre-lock pass only oriented
    // recovery; every mutable authority and restore fact is re-read and
    // authenticated while the per-slot lock is held before any mutation.
    const context = await assertCompleteChain(current, input, {
      heldTransactionId: journal.transactionId,
    });
    return await advance(current, input, context);
  } finally {
    await lock.release().catch(() => undefined);
  }
}

/**
 * Converges a candidate left `apply-in-progress` with no apply journal.
 *
 * No journal means no destination was ever touched: the journal is created
 * before the temporary write and long before the rename, so the only state to
 * undo is the candidate marker itself. The confirmation is still authenticated
 * first — it must be spent BY THIS transaction and bound to this candidate and
 * payload — so a candidate marked in-progress by anything other than a genuine
 * crashed apply fails closed rather than being quietly consumed.
 */
async function releaseStrandedCandidate(stranded, input) {
  const candidate = await showRestoreCandidate({
    projectRoot: input.projectRoot,
    env: input.env,
    secureFileOptions: input.secureFileOptions,
    candidateId: stranded.candidateId,
  });
  const state = candidate.candidateState;
  requireEvidence(
    state.state === 'apply-in-progress' &&
      state.transactionId === stranded.candidateState.transactionId &&
      state.contextId === stranded.candidateState.contextId &&
      candidate.slot === stranded.slot &&
      candidate.payloadHash === stranded.payloadHash,
    'stranded restore candidate changed during recovery',
  );
  requireEvidence(
    typeof state.transactionId === 'string' &&
      typeof state.contextId === 'string',
    'stranded restore candidate is not bound to a transaction',
  );
  let confirmation;
  try {
    confirmation = await readConfirmation({
      projectRoot: input.projectRoot,
      env: input.env,
      secureFileOptions: input.secureFileOptions,
      contextId: state.contextId,
    });
  } catch (error) {
    throw ownerIntervention(
      `stranded restore candidate has no readable confirmation: ${error.code ?? 'invalid'}`,
    );
  }
  requireEvidence(
    confirmation.state === 'spent' &&
      confirmation.transactionId === state.transactionId &&
      confirmation.candidateId === stranded.candidateId &&
      confirmation.candidatePayloadHash === stranded.payloadHash,
    'stranded restore candidate is not owned by a spent confirmation',
  );

  const store = createFormatV2Store({
    env: input.env,
    secureFileOptions: input.secureFileOptions,
  });
  const binding = await store.readProjectBinding(input.projectRoot);
  let lock;
  try {
    lock = await store.inspectLock(binding, candidate.slot);
  } catch (error) {
    throw ownerIntervention(
      `stranded restore candidate slot lock is unusable: ${error.code ?? 'invalid'}`,
    );
  }
  requireEvidence(
    lock === null,
    'stranded restore candidate slot lock is present and requires owner intervention',
  );

  // The apply service holds this lock continuously from before
  // markApplyInProgress through journal creation. Re-enumerating only after
  // observing no lock closes the journal-less classification race.
  const journalMatches = (await listApplyJournals({
    projectRoot: input.projectRoot,
    env: input.env,
    secureFileOptions: input.secureFileOptions,
  })).filter(journal =>
    journal.candidateId === stranded.candidateId ||
    journal.transactionId === state.transactionId);
  requireEvidence(
    journalMatches.length <= 1,
    'stranded restore candidate has conflicting apply journals',
  );
  if (journalMatches.length === 1) {
    const [journal] = journalMatches;
    requireEvidence(
      journal.candidateId === stranded.candidateId &&
        journal.transactionId === state.transactionId,
      'stranded restore candidate journal belongs to a conflicting transaction',
    );
    return { status: 'journaled', journal };
  }

  await consumeCandidate({
    projectRoot: input.projectRoot,
    env: input.env,
    secureFileOptions: input.secureFileOptions,
    candidateId: stranded.candidateId,
    transactionId: state.transactionId,
    outcome: 'failed',
    now: input.now,
  });
  return { status: 'released', journal: null };
}

export async function recoverRestoreTransactions({
  projectRoot,
  env = process.env,
  secureFileOptions = {},
  secureFs = defaultSecureFs,
  now = () => new Date(),
  beforeRecoveryLock,
} = {}) {
  const input = {
    projectRoot,
    env,
    secureFileOptions,
    secureFs,
    now,
    beforeRecoveryLock,
  };
  const journals = await listApplyJournals({
    projectRoot,
    env,
    secureFileOptions,
  });
  const recovered = [];
  const journalled = new Set(journals.map((journal) => journal.candidateId));
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

  // HOSTILE REVIEW, finding B: a crash between markApplyInProgress and
  // createApplyJournal leaves a candidate mid-apply with a spent confirmation
  // and NO journal. Nothing enumerated it, so it could never be applied and
  // never be restaged — stranded until someone deleted owner-local state by
  // hand. Journals cannot see it; the candidate store is the only witness.
  for (const stranded of await listApplyInProgressCandidates({
    projectRoot, env, secureFileOptions,
  })) {
    if (journalled.has(stranded.candidateId)) continue;
    const released = await releaseStrandedCandidate(stranded, input);
    let status = released.status;
    if (released.journal !== null) {
      status = released.journal.state === 'complete'
        ? 'complete'
        : await recoverOne(released.journal, input);
      journalled.add(released.journal.candidateId);
    }
    recovered.push(Object.freeze({
      transactionId: stranded.candidateState.transactionId ?? null,
      candidateId: stranded.candidateId,
      status,
    }));
  }
  return Object.freeze(recovered);
}
