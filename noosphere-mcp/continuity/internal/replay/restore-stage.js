import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import { ensureRealDirectoryPath } from '../../secure-fs.js';
import { TrustStoreError } from '../../trust-store-internal.js';
import {
  createRestoreCandidateFromSource,
  matchRestoreCandidateByTuple,
} from '../restore/candidate-store.js';
import { acquireCandidateIndexLock } from '../restore/candidate-index-lock.js';
import { releaseHeldLocks } from './lock-ranks.js';
import { RESTORE_SLOTS } from '../restore/constants.js';
import { recallRestoreSource } from '../restore/recall.js';
import { assertInteractiveStreams } from '../exact-confirmation.js';
import { createFormatV2Store } from '../trust-format-v2.js';
import {
  deriveRecallIdentity,
  deriveReplayIdentity,
} from './identity.js';
import {
  observeReplayInOperation,
  prepareReplayObservation,
} from './observe.js';
import { withReplayOperation } from './operation.js';

const UTF8 = new TextDecoder('utf-8', { fatal: true });

function stageError(code, message) {
  return new TrustStoreError(code, message);
}

function contentText(source) {
  try {
    const text = UTF8.decode(source.content);
    if (text.length === 0) {
      throw new Error('empty');
    }
    return text;
  } catch {
    throw stageError(
      'restore-source-content-invalid',
      'restore source content is not valid non-empty UTF-8',
    );
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export async function stageReplayAwareRestoreCandidate({
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
  onStep,
} = {}) {
  if (!Object.hasOwn(RESTORE_SLOTS, slot)) {
    throw stageError('restore-slot-invalid', 'restore slot is invalid');
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
  const content = contentText(source);
  const observedNow = now();
  if (!(observedNow instanceof Date) || Number.isNaN(observedNow.getTime())) {
    throw stageError('restore-clock-invalid', 'restore clock is invalid');
  }
  const store = createFormatV2Store({ env, secureFileOptions });
  const binding = await store.createProjectBinding(projectRoot);
  const authorityKey = await store.ensureMachineKey();
  const projectIdentityDigest =
    await store.canonicalProjectIdentityDigest(projectRoot);
  const identity = deriveReplayIdentity({
    projectIdentityDigest,
    slot,
    content,
  });
  const recallIdentity = deriveRecallIdentity({
    actionId: source.metadata?.actionId,
    blobId: source.metadata?.blobId,
    payloadDigest: identity.payloadDigest,
  });
  const observedAt = observedNow.toISOString();
  const candidatePayloadHash = sha256(source.content);

  return withReplayOperation({
    env,
    projectIdentityDigest,
    replayIdentity: identity.replayIdentity,
    observedAt,
    onStep,
  }, async context => {
    const restoreRoot = store.pathFor(binding, path.join('restore'));
    await ensureRealDirectoryPath(restoreRoot);
    const indexLock = await acquireCandidateIndexLock({
      scope: context.scope,
      root: restoreRoot,
      key: authorityKey,
      projectIdentityDigest,
      slot,
      candidatePayloadHash,
    });
    let operationFailure;
    try {
      const match = await matchRestoreCandidateByTuple({
        projectRoot,
        slot,
        candidatePayloadHash,
        env,
        secureFileOptions,
        now: () => observedNow,
      });
      const duplicateCandidate =
        match.status === 'active' || match.status === 'consumed';
      const prepared = prepareReplayObservation({
        env,
        projectIdentityDigest,
        slot,
        content,
        recallIdentity,
        origin: 'walrus-recall',
        observedAt,
        eventId: randomUUID(),
        duplicateCandidate,
        onStep,
      });
      const replay = await observeReplayInOperation(prepared, context);
      if (match.status === 'apply-in-progress') {
        throw stageError(
          'restore-candidate-match-in-progress',
          'matching restore candidate is apply-in-progress and requires owner intervention',
        );
      }
      if (match.status === 'active') {
        return Object.freeze({
          status: 'suppressed',
          replayClassification: replay.classification,
          projectIdentityDigest,
          candidate: match.candidate,
        });
      }
      if (match.status === 'consumed') {
        return Object.freeze({
          status: 'already-consumed',
          replayClassification: replay.classification,
          projectIdentityDigest,
          candidateId: match.candidateId,
          outcome: match.outcome,
        });
      }
      const staged = await createRestoreCandidateFromSource({
        projectRoot,
        slot,
        source,
        env,
        secureFileOptions,
        randomBytes,
        now: () => observedNow,
      });
      return Object.freeze({
        ...staged,
        replayClassification: replay.classification,
        projectIdentityDigest,
      });
    } catch (error) {
      operationFailure = error;
      throw error;
    } finally {
      await releaseHeldLocks([indexLock], operationFailure);
    }
  });
}
