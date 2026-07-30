import { randomUUID } from 'node:crypto';

import {
  quoteUntrustedMemory,
  sanitizeMemoryText,
} from '../../memory-safety.js';
import { TrustStoreError } from '../../trust-store-internal.js';
import { createFormatV2Store } from '../trust-format-v2.js';
import {
  deriveRecallIdentity,
  deriveReplayIdentity,
} from './identity.js';
import { observeReplay } from './observe.js';

const MAX_RECALLED_CONTENT_BYTES = 1_048_576;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const UTC_MILLISECONDS =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function presentationError(code, message) {
  return new TrustStoreError(code, message);
}

function canonicalNow(now) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw presentationError('replay-clock-invalid', 'local replay clock is invalid');
  }
  return value;
}

function validContent(memory) {
  return memory &&
    typeof memory === 'object' &&
    !Array.isArray(memory) &&
    Object.getPrototypeOf(memory) === Object.prototype &&
    typeof memory.content === 'string' &&
    Buffer.byteLength(memory.content, 'utf8') > 0 &&
    Buffer.byteLength(memory.content, 'utf8') <= MAX_RECALLED_CONTENT_BYTES;
}

export function classifyFreshness(remoteTimestamp, observedNow) {
  if (
    typeof remoteTimestamp !== 'string' ||
    !UTC_MILLISECONDS.test(remoteTimestamp)
  ) {
    return 'TIME_UNVERIFIED';
  }
  const remote = new Date(remoteTimestamp);
  if (
    Number.isNaN(remote.getTime()) ||
    remote.toISOString() !== remoteTimestamp ||
    remote.getTime() > observedNow.getTime() + FIVE_MINUTES_MS
  ) {
    return 'TIME_UNVERIFIED';
  }
  return observedNow.getTime() - remote.getTime() > THIRTY_DAYS_MS
    ? 'STALE'
    : 'CURRENT';
}

async function projectDigest(projectRoot, env) {
  return createFormatV2Store({ env })
    .canonicalProjectIdentityDigest(projectRoot);
}

async function observeMemory({
  env,
  projectRoot,
  projectIdentityDigest,
  slot,
  memory,
  observedNow,
}) {
  const content = memory.content;
  const identity = deriveReplayIdentity({
    projectIdentityDigest,
    slot,
    content,
  });
  const recallIdentity = deriveRecallIdentity({
    actionId: memory.action_id,
    blobId: memory.blob_id,
    payloadDigest: identity.payloadDigest,
  });
  let replayClassification = 'UNAVAILABLE';
  let replayErrorCode = null;
  try {
    const replay = await observeReplay({
      env,
      projectIdentityDigest,
      slot,
      content,
      recallIdentity,
      origin: 'walrus-recall',
      observedAt: observedNow.toISOString(),
      eventId: randomUUID(),
      duplicateCandidate: false,
    });
    replayClassification = replay.classification;
  } catch (error) {
    replayErrorCode = error?.code ?? 'replay-unavailable';
  }
  return Object.freeze({
    content: sanitizeMemoryText(content),
    replayClassification,
    replayErrorCode,
    freshness: classifyFreshness(memory.timestamp, observedNow),
  });
}

function unavailableMemory(memory, observedNow, error) {
  return Object.freeze({
    content: sanitizeMemoryText(memory.content),
    replayClassification: 'UNAVAILABLE',
    replayErrorCode: error?.code ?? 'replay-project-identity-unavailable',
    freshness: classifyFreshness(memory.timestamp, observedNow),
  });
}

export function renderTypedMemory(item) {
  return [
    `Replay: ${item.replayClassification}`,
    `Freshness: ${item.freshness}`,
    '',
    quoteUntrustedMemory(item.content),
  ].join('\n');
}

export async function observeTypedMemory({
  env = process.env,
  projectRoot,
  projectIdentityDigest,
  slot,
  memory,
  now = () => new Date(),
}) {
  if (!validContent(memory)) {
    throw presentationError(
      'replay-typed-memory-invalid',
      'typed recalled memory is invalid',
    );
  }
  const observedNow = canonicalNow(now);
  let digest = projectIdentityDigest;
  if (!digest) {
    try {
      digest = await projectDigest(projectRoot, env);
    } catch (error) {
      return unavailableMemory(memory, observedNow, error);
    }
  }
  return observeMemory({
    env,
    projectRoot,
    projectIdentityDigest: digest,
    slot,
    memory,
    observedNow,
  });
}

function invalidOrdinaryItem() {
  return Object.freeze({
    content: '(invalid recalled evidence)',
    replayClassification: 'UNAVAILABLE',
    replayErrorCode: 'replay-ordinary-memory-invalid',
    freshness: 'TIME_UNVERIFIED',
  });
}

export async function ingestOrdinaryRecall({
  env = process.env,
  projectRoot,
  projectIdentityDigest,
  response,
  now = () => new Date(),
}) {
  if (
    !response ||
    typeof response !== 'object' ||
    Array.isArray(response) ||
    !Array.isArray(response.memories)
  ) {
    throw presentationError(
      'replay-ordinary-response-invalid',
      'structured ordinary recall response is invalid',
    );
  }
  const observedNow = canonicalNow(now);
  let digest = projectIdentityDigest;
  let digestError = null;
  if (!digest) {
    try {
      digest = await projectDigest(projectRoot, env);
    } catch (error) {
      digestError = error;
    }
  }
  const items = [];
  for (const memory of response.memories) {
    items.push(validContent(memory)
      ? digestError
        ? unavailableMemory(memory, observedNow, digestError)
        : await observeMemory({
          env,
          projectRoot,
          projectIdentityDigest: digest,
          slot: 'ordinary',
          memory,
          observedNow,
        })
      : invalidOrdinaryItem());
  }
  const rendered = items.length === 0
    ? 'No recalled project memory.'
    : items.map((item, index) => [
      `### Recalled item ${index + 1}`,
      '',
      renderTypedMemory(item),
    ].join('\n')).join('\n\n');
  return Object.freeze({
    items: Object.freeze(items),
    rendered,
  });
}
