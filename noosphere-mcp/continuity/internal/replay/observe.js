import { randomUUID } from 'node:crypto';

import { TrustStoreError } from '../../trust-store-internal.js';
import { AUTH_DOMAINS, sealRecord } from '../authenticated-records.js';
import { classifyReplayObservation } from './classify.js';
import { deriveReplayIdentity } from './identity.js';
import {
  acquireReplayIdentityLock,
  acquireReplayProjectLock,
} from './lock.js';
import { createRankedLockScope } from './lock-ranks.js';
import {
  commitReplayRecord,
  ensureReplayProject,
  readReplayRecord,
} from './store.js';
import { replayKeyId } from './key.js';

const SHA256_ID = /^sha256:[0-9a-f]{64}$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function observeError(code, message) {
  return new TrustStoreError(code, message);
}

function isCanonicalTimestamp(value) {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function validateInput(input) {
  if (
    !SHA256_ID.test(input.recallIdentity) ||
    !['walrus-recall', 'local-file-recall'].includes(input.origin) ||
    !isCanonicalTimestamp(input.observedAt) ||
    !UUID_V4.test(input.eventId) ||
    typeof input.duplicateCandidate !== 'boolean'
  ) {
    throw observeError('replay-observation-invalid', 'replay observation is invalid');
  }
}

export async function observeReplay(input) {
  const normalizedInput = {
    ...input,
    eventId: input.eventId ?? randomUUID(),
  };
  validateInput(normalizedInput);
  const {
    env = process.env,
    projectIdentityDigest,
    slot,
    content,
    recallIdentity,
    origin,
    observedAt,
    eventId,
    duplicateCandidate,
  } = normalizedInput;
  const identity = deriveReplayIdentity({
    projectIdentityDigest,
    slot,
    content,
  });
  const { key } = await ensureReplayProject({ env, projectIdentityDigest });
  const scope = createRankedLockScope();
  const projectLock = await acquireReplayProjectLock({
    scope,
    env,
    key,
    projectIdentityDigest,
  });
  const identityLock = await acquireReplayIdentityLock({
    scope,
    env,
    key,
    projectIdentityDigest,
    replayIdentity: identity.replayIdentity,
  });
  try {
    const prior = await readReplayRecord({
      env,
      key,
      projectIdentityDigest,
      replayIdentity: identity.replayIdentity,
    });
    const next = classifyReplayObservation({
      priorCount: prior?.replayCount ?? 0,
      duplicateCandidate,
    });
    const effectiveObservedAt =
      prior && prior.lastSeen.observedAt > observedAt
        ? prior.lastSeen.observedAt
        : observedAt;
    const seen = Object.freeze({
      eventId,
      observedAt: effectiveObservedAt,
      recallIdentity,
    });
    const fields = {
      domain: AUTH_DOMAINS.replayRecord,
      schema: 'noosphere.replay-record',
      version: 1,
      replayIdentity: identity.replayIdentity,
      projectIdentityDigest,
      slot,
      payloadDigest: identity.payloadDigest,
      recallIdentity,
      firstSeen: prior?.firstSeen ?? seen,
      lastSeen: seen,
      replayCount: next.replayCount,
      state: next.state,
      lastClassification: next.classification,
      origin,
      recordGeneration: next.replayCount,
      keyId: replayKeyId(key),
    };
    const record = sealRecord(key, AUTH_DOMAINS.replayRecord, fields);
    await commitReplayRecord({
      env,
      key,
      projectIdentityDigest,
      record,
    });
    return Object.freeze({
      classification: next.classification,
      record,
    });
  } finally {
    await identityLock.release();
    await projectLock.release();
  }
}
