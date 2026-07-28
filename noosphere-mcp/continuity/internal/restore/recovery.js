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
 * Classifies an already-authenticated slot lock as `abandoned`, `live`, or
 * `ambiguous`. Only `abandoned` may be reclaimed.
 *
 * The input must already have come back from `store.inspectLock`, which proves
 * ownership: MAC over the slot-lock domain, this project identity and identity
 * digest, this owner scope, this machine key, this slot. A malformed,
 * unauthenticated, foreign, or unsafe lock never reaches here. The only question
 * left is liveness.
 *
 * Exactly one signal: `kill(pid, 0)`. ESRCH means gone. Success means running.
 * EPERM means the process exists but belongs to another user, which is
 * existence, so it is live. Every other errno is unclassifiable and therefore
 * ambiguous, which fails closed.
 *
 * There is deliberately NO clock- or uptime-derived signal. An earlier version
 * also treated "the lock predates the machine's current boot" as abandonment,
 * on the reasoning that a wall clock could only cost a fail-closed refusal.
 * That was wrong, and hostile review caught it: a clock that jumps FORWARD (NTP
 * correction, VM resume, a container inheriting a skewed host clock) makes a
 * LIVE lock's `startedAt` older than uptime, so it is declared abandoned and
 * reclaimed out from under a running transaction. That is fail-open, and no
 * wall-clock-derived boot identity avoids it — a forward jump moves the derived
 * boot time by the same amount. The signal is removed rather than patched.
 * Removing it also removes the `os.uptime()` call, which throws EPERM under
 * some sandbox and container profiles.
 *
 * The cost is the case that signal existed for: after a reboot a dead
 * transaction's PID may be reused by an unrelated live process, and recovery
 * will report `live` indefinitely. That is fail-closed and visible — the owner
 * gets ERR_RESTORE_OWNER_INTERVENTION_REQUIRED naming the PID and can clear the
 * lock. Matching the Phase 4A stance: never reclaim on a guess.
 *
 * Age alone is never a reason. A lock is not reclaimed because it is old.
 */
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
 * Removes the exact lock file the barrier authenticated and proved abandoned —
 * and nothing else.
 *
 * Removing by path alone is a race: between the verdict and the removal a
 * competitor can clear the dead lock and take its own, and a path-based `rm`
 * would then delete a LIVE lock while its owner believes it holds one. So the
 * file is re-identified immediately before removal — same inode, device and
 * size, same authenticated bytes, same transaction, still abandoned — and
 * anything else fails closed.
 *
 * Residual, stated rather than hidden: Node offers no `funlinkat`, so a window
 * remains between the final check and `unlink`. It is far smaller than the
 * verdict-to-removal window it replaces, and a competitor that loses this way
 * still detects it — `release()` compares lock tokens and refuses with
 * `trust-lock-not-owner` rather than silently continuing.
 *
 * Exported for direct testing: the enclosing barrier rejects a foreign
 * transactionId earlier, so the race window this closes is unreachable through
 * recoverRestoreTransactions alone.
 */
export async function reclaimAbandonedLock(store, binding, slot, expected) {
  const file = store.lockPath(binding, slot);
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw ownerIntervention(`restore slot lock could not be re-identified: ${error.code ?? 'invalid'}`);
  }
  requireEvidence(
    stat.isFile() &&
      stat.ino === expected.identity.ino &&
      stat.dev === expected.identity.dev &&
      stat.size === expected.identity.size,
    'restore slot lock file changed between authentication and reclaim',
  );

  let current;
  try {
    current = await store.inspectLock(binding, slot);
  } catch (error) {
    throw ownerIntervention(`restore slot lock became unusable before reclaim: ${error.code ?? 'invalid'}`);
  }
  requireEvidence(
    current !== null &&
      current.mac === expected.lock.mac &&
      current.transactionId === expected.lock.transactionId &&
      current.token === expected.lock.token,
    'restore slot lock was replaced between authentication and reclaim',
  );
  requireEvidence(
    classifyLockLiveness(current) === 'abandoned',
    'restore slot lock became live before reclaim',
  );
  await fs.rm(file, { force: false });
  return true;
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
  // A lock left behind by a SIGKILLed process must not hide the transaction
  // forever, but it is also the only thing standing between recovery and a
  // genuinely live competitor. inspectLock proves ownership or throws; only
  // then may liveness decide, and only `abandoned` may be reclaimed.
  let lock;
  try {
    lock = await store.inspectLock(binding, journal.slot);
  } catch (error) {
    throw ownerIntervention(`restore slot lock is unusable: ${error.code ?? 'invalid'}`);
  }
  if (lock === null) return { store, binding, staleLock: null };

  requireEvidence(
    lock.transactionId === journal.transactionId,
    'restore slot lock belongs to a different transaction',
  );
  const liveness = classifyLockLiveness(lock);
  requireEvidence(
    liveness === 'abandoned',
    liveness === 'live'
      ? `restore slot lock is held by a live process (pid ${lock.pid})`
      : 'restore slot lock ownership could not be proven abandoned',
  );
  let identity;
  try {
    const stat = await fs.lstat(store.lockPath(binding, journal.slot));
    identity = { ino: stat.ino, dev: stat.dev, size: stat.size };
  } catch (error) {
    throw ownerIntervention(`restore slot lock could not be identified: ${error.code ?? 'invalid'}`);
  }
  return { store, binding, staleLock: { lock, identity } };
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
  const { store, binding, staleLock } = context;
  // Reclaim only the exact lock file the barrier authenticated and proved
  // abandoned. `force: false` so a lock that vanished between the barrier and
  // here — meaning something else moved — raises rather than silently
  // succeeding, and the transaction stays for the owner.
  if (staleLock !== null) {
    await reclaimAbandonedLock(store, binding, journal.slot, staleLock);
  }
  let lock;
  try {
    lock = await store.acquireLock(binding, journal.slot);
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
