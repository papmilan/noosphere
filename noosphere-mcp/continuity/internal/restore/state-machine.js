import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  acquireOwnerOnlyLock,
  atomicOwnerOnlyWrite,
  ensureRealDirectoryPath,
  readBoundedRegularFile,
  writeOwnerOnlyFileExclusive,
} from '../../secure-fs.js';
import { TrustStoreError, canonicalize } from '../../trust-store-internal.js';
import { sealRecord, verifyRecord } from '../authenticated-records.js';
import { RESTORE_RECORD_BYTES } from './constants.js';

export const CONFIRMATION_TRANSITIONS = Object.freeze({
  issued: Object.freeze(new Set(['confirmed', 'spent'])),
  confirmed: Object.freeze(new Set(['spent'])),
});

export const CANDIDATE_TRANSITIONS = Object.freeze({
  active: Object.freeze(new Set(['apply-in-progress'])),
  'apply-in-progress': Object.freeze(new Set(['consumed'])),
});

const EVENT_FIELDS = new Set([
  'contextId',
  'createdAt',
  'domain',
  'entityId',
  'entityKind',
  'eventId',
  'keyId',
  'mac',
  'outcome',
  'previousEventHash',
  'previousEventId',
  'projectIdentityDigest',
  'reason',
  'schema',
  'sequence',
  'state',
  'transactionId',
  'version',
]);
const CURRENT_FIELDS = new Set([
  'contextId',
  'currentEventHash',
  'currentEventId',
  'domain',
  'entityId',
  'entityKind',
  'keyId',
  'mac',
  'outcome',
  'projectIdentityDigest',
  'reason',
  'schema',
  'sequence',
  'state',
  'transactionId',
  'version',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const IDENTITY = /^sha256:[0-9a-f]{64}$/;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

function stateError(code, message) {
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
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function statePaths(root) {
  return Object.freeze({
    stateRoot: path.join(root, 'state'),
    events: path.join(root, 'state', 'events'),
    current: path.join(root, 'state', 'current.json'),
    lock: path.join(root, 'state', 'transition.lock'),
  });
}

function validateCommon(value, expected) {
  return value.domain === expected.domain &&
    value.entityKind === expected.entityKind &&
    value.entityId === expected.entityId &&
    value.projectIdentityDigest === expected.projectIdentityDigest &&
    value.keyId === expected.keyId &&
    IDENTITY.test(value.projectIdentityDigest) &&
    HASH.test(value.keyId) &&
    Number.isInteger(value.sequence) &&
    value.sequence >= 1 &&
    typeof value.state === 'string' &&
    (value.contextId === null || UUID.test(value.contextId)) &&
    (value.transactionId === null || UUID.test(value.transactionId)) &&
    (value.outcome === null || ['applied', 'failed'].includes(value.outcome)) &&
    (value.reason === null ||
      (typeof value.reason === 'string' && value.reason.length <= 128));
}

function validStateMetadata(value) {
  if (value.entityKind === 'candidate') {
    if (value.state === 'active') {
      return value.contextId === null &&
        value.transactionId === null &&
        value.outcome === null &&
        value.reason === null;
    }
    if (value.state === 'apply-in-progress') {
      return UUID.test(value.contextId) &&
        UUID.test(value.transactionId) &&
        value.outcome === null &&
        value.reason === null;
    }
    if (value.state === 'consumed') {
      return UUID.test(value.contextId) &&
        UUID.test(value.transactionId) &&
        ['applied', 'failed'].includes(value.outcome) &&
        value.reason === null;
    }
    return false;
  }
  if (value.entityKind === 'confirmation') {
    if (value.state === 'issued' || value.state === 'confirmed') {
      return value.contextId === value.entityId &&
        value.transactionId === null &&
        value.outcome === null &&
        value.reason === null;
    }
    if (value.state === 'spent') {
      return value.contextId === value.entityId &&
        value.outcome === null &&
        typeof value.reason === 'string';
    }
    return false;
  }
  return false;
}

function validateEvent(event, expected) {
  return exactFields(event, EVENT_FIELDS) &&
    event.schema === 'noosphere.restore-state-event' &&
    event.version === 1 &&
    UUID.test(event.eventId) &&
    canonicalTimestamp(event.createdAt) &&
    (event.previousEventId === null || UUID.test(event.previousEventId)) &&
    (event.previousEventHash === null || HASH.test(event.previousEventHash)) &&
    validateCommon(event, expected) &&
    validStateMetadata(event);
}

function validateCurrent(current, expected) {
  return exactFields(current, CURRENT_FIELDS) &&
    current.schema === 'noosphere.restore-current-state' &&
    current.version === 1 &&
    UUID.test(current.currentEventId) &&
    HASH.test(current.currentEventHash) &&
    validateCommon(current, expected) &&
    validStateMetadata(current);
}

async function readCanonical(file, secureFileOptions) {
  let bytes;
  try {
    bytes = await readBoundedRegularFile(file, {
      maxBytes: RESTORE_RECORD_BYTES,
      ...secureFileOptions,
    });
  } catch (error) {
    throw stateError(
      'ERR_RESTORE_STATE_INVALID',
      `restore state file is unsafe: ${error.code ?? 'read-failed'}`,
    );
  }
  if (bytes === null) return null;
  let text;
  let parsed;
  try {
    text = UTF8.decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    throw stateError(
      'ERR_RESTORE_STATE_INVALID',
      'restore state record is malformed',
    );
  }
  if (text !== canonicalize(parsed)) {
    throw stateError(
      'ERR_RESTORE_STATE_INVALID',
      'restore state record is not canonical',
    );
  }
  return Object.freeze({ bytes, parsed });
}

function buildEvent({
  expected,
  sequence,
  state,
  previous,
  metadata,
  now,
  eventId,
}) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw stateError(
      'ERR_RESTORE_STATE_INVALID',
      'restore state transition time is invalid',
    );
  }
  return {
    domain: expected.domain,
    schema: 'noosphere.restore-state-event',
    version: 1,
    entityKind: expected.entityKind,
    entityId: expected.entityId,
    projectIdentityDigest: expected.projectIdentityDigest,
    keyId: expected.keyId,
    sequence,
    eventId,
    previousEventId: previous?.eventId ?? null,
    previousEventHash: previous?.eventHash ?? null,
    state,
    contextId: metadata.contextId ?? null,
    transactionId: metadata.transactionId ?? null,
    outcome: metadata.outcome ?? null,
    reason: metadata.reason ?? null,
    createdAt: now.toISOString(),
  };
}

function buildCurrent(expected, event, eventHash) {
  return {
    domain: expected.domain,
    schema: 'noosphere.restore-current-state',
    version: 1,
    entityKind: expected.entityKind,
    entityId: expected.entityId,
    projectIdentityDigest: expected.projectIdentityDigest,
    keyId: expected.keyId,
    sequence: event.sequence,
    currentEventId: event.eventId,
    currentEventHash: eventHash,
    state: event.state,
    contextId: event.contextId,
    transactionId: event.transactionId,
    outcome: event.outcome,
    reason: event.reason,
  };
}

export function assertTransition(table, from, to, code) {
  if (!table[from]?.has(to)) {
    throw stateError(code, `${from} cannot become ${to}`);
  }
}

export async function createStateMachine({
  root,
  key,
  expected,
  initialState,
  metadata = {},
  now,
  eventId = randomUUID(),
  secureFileOptions = {},
}) {
  const paths = statePaths(root);
  await ensureRealDirectoryPath(paths.events);
  const eventFields = buildEvent({
    expected,
    sequence: 1,
    state: initialState,
    previous: null,
    metadata,
    now,
    eventId,
  });
  const event = sealRecord(key, expected.domain, eventFields);
  const eventBytes = canonicalize(event);
  const current = sealRecord(
    key,
    expected.domain,
    buildCurrent(expected, event, hash(eventBytes)),
  );
  await writeOwnerOnlyFileExclusive(
    path.join(paths.events, `1-${eventId}.json`),
    eventBytes,
    secureFileOptions,
  );
  await writeOwnerOnlyFileExclusive(
    paths.current,
    canonicalize(current),
    secureFileOptions,
  );
  return readStateMachine({ root, key, expected, secureFileOptions });
}

export async function readStateMachine({
  root,
  key,
  expected,
  transitions,
  secureFileOptions = {},
}) {
  const paths = statePaths(root);
  const currentResult = await readCanonical(paths.current, secureFileOptions);
  const entries = await fs.readdir(paths.events, { withFileTypes: true })
    .catch(error => {
      if (error.code === 'ENOENT') return [];
      throw stateError(
        'ERR_RESTORE_STATE_INVALID',
        `restore state directory is unreadable: ${error.code ?? 'invalid'}`,
      );
    });
  if (!currentResult || entries.length === 0) {
    throw stateError(
      'ERR_RESTORE_STATE_INVALID',
      'restore current state or immutable history is missing',
    );
  }
  const current = currentResult.parsed;
  if (!validateCurrent(current, expected) ||
      !verifyRecord(key, expected.domain, current)) {
    throw stateError(
      'ERR_RESTORE_STATE_INVALID',
      'restore current state is invalid or unauthenticated',
    );
  }
  const bySequence = new Map();
  for (const entry of entries) {
    if (!entry.isFile() || !/^[1-9][0-9]*-[0-9a-f-]{36}\.json$/.test(entry.name)) {
      throw stateError(
        'ERR_RESTORE_STATE_INVALID',
        'restore state history contains an invalid entry',
      );
    }
    const result = await readCanonical(
      path.join(paths.events, entry.name),
      secureFileOptions,
    );
    const event = result?.parsed;
    if (!event ||
        !validateEvent(event, expected) ||
        !verifyRecord(key, expected.domain, event) ||
        entry.name !== `${event.sequence}-${event.eventId}.json` ||
        bySequence.has(event.sequence)) {
      throw stateError(
        'ERR_RESTORE_STATE_INVALID',
        'restore state event is invalid, unauthenticated, or duplicated',
      );
    }
    bySequence.set(event.sequence, Object.freeze({
      event,
      eventHash: hash(result.bytes),
    }));
  }
  if (bySequence.size !== current.sequence ||
      entries.length !== current.sequence) {
    throw stateError(
      'ERR_RESTORE_STATE_INVALID',
      'restore state history was rolled back, forked, or truncated',
    );
  }
  let previous = null;
  for (let sequence = 1; sequence <= current.sequence; sequence += 1) {
    const item = bySequence.get(sequence);
    if (!item ||
        item.event.previousEventId !== (previous?.event.eventId ?? null) ||
        item.event.previousEventHash !== (previous?.eventHash ?? null) ||
        (previous &&
         !transitions?.[previous.event.state]?.has(item.event.state))) {
      throw stateError(
        'ERR_RESTORE_STATE_INVALID',
        'restore state event chain is incomplete',
      );
    }
    previous = item;
  }
  if (current.currentEventId !== previous.event.eventId ||
      current.currentEventHash !== previous.eventHash ||
      current.state !== previous.event.state ||
      current.contextId !== previous.event.contextId ||
      current.transactionId !== previous.event.transactionId ||
      current.outcome !== previous.event.outcome ||
      current.reason !== previous.event.reason) {
    throw stateError(
      'ERR_RESTORE_STATE_INVALID',
      'restore current state does not select the history head',
    );
  }
  return Object.freeze({
    ...current,
    event: previous.event,
    eventHash: previous.eventHash,
  });
}

export async function transitionStateMachine({
  root,
  key,
  expected,
  transitions,
  to,
  code,
  metadata = {},
  now,
  eventId = randomUUID(),
  secureFileOptions = {},
}) {
  const paths = statePaths(root);
  let lock;
  try {
    lock = await acquireOwnerOnlyLock(paths.lock, {
      metadata: {
        entityKind: expected.entityKind,
        entityId: expected.entityId,
      },
      ...secureFileOptions,
    });
  } catch (error) {
    throw stateError(
      'ERR_RESTORE_STATE_LOCKED',
      `restore state transition is locked: ${error.code ?? 'invalid'}`,
    );
  }
  try {
    const current = await readStateMachine({
      root,
      key,
      expected,
      transitions,
      secureFileOptions,
    });
    assertTransition(transitions, current.state, to, code);
    const eventFields = buildEvent({
      expected,
      sequence: current.sequence + 1,
      state: to,
      previous: {
        eventId: current.currentEventId,
        eventHash: current.currentEventHash,
      },
      metadata,
      now,
      eventId,
    });
    const event = sealRecord(key, expected.domain, eventFields);
    const eventBytes = canonicalize(event);
    const eventHash = hash(eventBytes);
    await writeOwnerOnlyFileExclusive(
      path.join(paths.events, `${event.sequence}-${event.eventId}.json`),
      eventBytes,
      secureFileOptions,
    );
    const next = sealRecord(
      key,
      expected.domain,
      buildCurrent(expected, event, eventHash),
    );
    await atomicOwnerOnlyWrite(
      paths.current,
      canonicalize(next),
      secureFileOptions,
    );
    return readStateMachine({
      root,
      key,
      expected,
      transitions,
      secureFileOptions,
    });
  } finally {
    await lock.release().catch(() => undefined);
  }
}
