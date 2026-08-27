// ACP Execution Continuity domain object. An execution state is a short-lived
// cursor over one Project State snapshot: it records where an agent was
// standing (current step, target file/symbol, last validation result), never
// what is true about the project and never any code to apply. Everything here
// is advisory for a successor agent and is validated with the same discipline
// as the Project State envelope: untrusted input in, ordered deterministic
// errors or a deep-frozen state out.

import { findJsonValueErrors, findNormalizedKeyCollisions } from './wire.js';

export const EXECUTION_PROTOCOL = 'acp.execution-state/1';

const FORBIDDEN_KEY = /(?:chain[ _-]?of[ _-]?thought|hidden[ _-]?reasoning|token[ _-]?trace|internal[ _-]?deliberation|private[ _-]?reasoning|system[ _-]?prompt)/i;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SNAPSHOT_ID = /^sha256:[a-f0-9]{64}$/;
// A checkpoint carries locations and goals, never payloads. Fenced code,
// diff/patch syntax, and multi-line prose are rejected outright because they
// are exactly how executable content would smuggle itself into an advisory
// record.
const PAYLOAD_PATTERNS = [
  /```/,
  /^diff --git /m,
  /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m,
  /^(?:\+\+\+|---) [ab]\//m,
];
const MAX_PROSE_NEWLINES = 3;

export const executionPolicy = Object.freeze({
  maxSteps: 64,
  maxNotes: 8,
  maxNoteLength: 240,
  maxProseLength: 240,
  maxCommandLength: 200,
  maxFrontierItems: 10,
  maxOpenedFiles: 16,
  maxFailingTests: 32,
  maxFutureCreatedAtMs: 5 * 60 * 1000,
});

const CURSOR_STATUSES = ['planning', 'before-edit', 'mid-edit', 'verifying', 'blocked', 'handoff'];
const STEP_KINDS = ['task', 'edit', 'test', 'verify', 'investigate', 'commit'];
const STEP_STATUSES = ['done', 'current', 'pending', 'skipped', 'blocked'];
const RESULTS = ['pass', 'fail', 'error'];
const SIGNATURE_STATUSES = ['unsigned', 'local-unverified', 'signed'];

export function createExecutionState(envelope, { clock, policy = executionPolicy } = {}) {
  const jsonErrors = findJsonValueErrors(envelope);
  if (jsonErrors.length) return { ok: false, errors: orderErrors(jsonErrors) };
  const normalizationErrors = findNormalizedKeyCollisions(envelope);
  if (normalizationErrors.length) return { ok: false, errors: orderErrors(normalizationErrors) };
  const normalized = normalizeEnvelope(envelope);
  const effectivePolicy = { ...executionPolicy, ...policy };
  const errors = validateEnvelope(normalized, effectivePolicy, clock);
  if (errors.length) return { ok: false, errors: orderErrors(errors) };

  const runtime = buildRuntime(normalized, clock);
  return {
    ok: true,
    state: Object.freeze({
      envelope: deepFreeze(normalized),
      runtime: deepFreeze(runtime),
    }),
  };
}

function validateEnvelope(envelope, limits, clock) {
  const errors = [];
  if (!isObject(envelope)) {
    error(errors, '$', 'invalid-type', 'envelope must be an object');
    return errors;
  }
  scanTree(envelope, '$', errors, limits);

  allowedKeys(envelope, '$', [
    'protocol', 'project_snapshot_id', 'created_at', 'expires_at', 'origin',
    'repository', 'cursor', 'steps', 'frontier', 'validation', 'working_notes',
    'integrity',
  ], errors);
  required(envelope, '$', [
    'protocol', 'project_snapshot_id', 'created_at', 'expires_at', 'origin',
    'repository', 'cursor', 'steps', 'frontier', 'validation', 'working_notes',
    'integrity',
  ], errors);

  if (envelope.protocol !== EXECUTION_PROTOCOL) {
    error(errors, '$.protocol', 'invalid-protocol', `protocol must be ${EXECUTION_PROTOCOL}`);
  }
  if (typeof envelope.project_snapshot_id !== 'string' || !SNAPSHOT_ID.test(envelope.project_snapshot_id)) {
    error(errors, '$.project_snapshot_id', 'invalid-snapshot-id', 'must be a sha256 snapshot id');
  }
  timestamp(envelope.created_at, '$.created_at', errors);
  const observedNow = typeof clock === 'string' ? Date.parse(clock) : Date.now();
  if (validTimestamp(envelope.created_at) && Number.isFinite(observedNow)
    && Date.parse(envelope.created_at) > observedNow + limits.maxFutureCreatedAtMs) {
    error(errors, '$.created_at', 'future-created-at', 'created_at is implausibly ahead of the observed clock');
  }
  if (envelope.expires_at == null) {
    error(errors, '$.expires_at', 'missing-expiry', 'expires_at is required; age demotion needs a boundary');
  } else {
    timestamp(envelope.expires_at, '$.expires_at', errors);
    if (validTimestamp(envelope.created_at) && validTimestamp(envelope.expires_at)
      && envelope.expires_at < envelope.created_at) {
      error(errors, '$.expires_at', 'invalid-expiry', 'expires_at must not be before created_at');
    }
  }

  validateOrigin(envelope.origin, errors, limits);
  validateRepository(envelope.repository, errors, limits);
  validateCursor(envelope.cursor, errors, limits);
  validateSteps(envelope.steps, errors, limits);
  validateFrontier(envelope.frontier, errors, limits);
  validateValidation(envelope.validation, errors, limits);
  validateNotes(envelope.working_notes, errors, limits);
  validateIntegrity(envelope.integrity, errors, limits);
  validateGraph(envelope, errors);
  return errors;
}

function validateOrigin(value, errors, limits) {
  if (!isObject(value)) return error(errors, '$.origin', 'invalid-type', 'must be an object');
  allowedKeys(value, '$.origin', ['agent_id', 'client', 'session_id'], errors);
  prose(value.agent_id, '$.origin.agent_id', errors, limits);
  prose(value.client, '$.origin.client', errors, limits);
  if (value.session_id != null) prose(value.session_id, '$.origin.session_id', errors, limits);
}

function validateRepository(value, errors, limits) {
  if (!isObject(value)) return error(errors, '$.repository', 'invalid-type', 'must be an object');
  allowedKeys(value, '$.repository', ['project_id', 'head', 'branch', 'dirty', 'workspace_fingerprint'], errors);
  required(value, '$.repository', ['project_id', 'dirty', 'workspace_fingerprint'], errors);
  prose(value.project_id, '$.repository.project_id', errors, limits);
  if (value.head != null && !/^[a-f0-9]{40}$/.test(String(value.head))) {
    error(errors, '$.repository.head', 'invalid-head', 'must be a 40-hex commit or null');
  }
  if (value.branch != null) prose(value.branch, '$.repository.branch', errors, limits);
  if (typeof value.dirty !== 'boolean') error(errors, '$.repository.dirty', 'invalid-type', 'must be a boolean');
  if (typeof value.workspace_fingerprint !== 'string' || !SNAPSHOT_ID.test(value.workspace_fingerprint)) {
    error(errors, '$.repository.workspace_fingerprint', 'invalid-fingerprint', 'must be a sha256 fingerprint');
  }
}

function validateCursor(value, errors, limits) {
  if (!isObject(value)) return error(errors, '$.cursor', 'invalid-type', 'must be an object');
  allowedKeys(value, '$.cursor', ['step_id', 'status', 'opened_files', 'target'], errors);
  required(value, '$.cursor', ['step_id', 'status', 'opened_files', 'target'], errors);
  prose(value.step_id, '$.cursor.step_id', errors, limits);
  enumValue(value.status, '$.cursor.status', CURSOR_STATUSES, errors);
  if (!Array.isArray(value.opened_files)) {
    error(errors, '$.cursor.opened_files', 'invalid-type', 'must be an array');
  } else {
    if (value.opened_files.length > limits.maxOpenedFiles) error(errors, '$.cursor.opened_files', 'too-many-items', `at most ${limits.maxOpenedFiles} opened files`);
    value.opened_files.forEach((file, index) => prose(file, `$.cursor.opened_files[${index}]`, errors, limits));
  }
  validateTarget(value.target, '$.cursor.target', errors, limits, { hash: false });
}

function validateTarget(value, path, errors, limits, { hash }) {
  if (!isObject(value)) return error(errors, path, 'invalid-type', 'must be an object');
  allowedKeys(value, path, hash ? ['file', 'symbol', 'content_hash'] : ['file', 'symbol', 'purpose'], errors);
  prose(value.file, `${path}.file`, errors, limits);
  if (value.symbol != null) prose(value.symbol, `${path}.symbol`, errors, limits);
  if (!hash && value.purpose != null) prose(value.purpose, `${path}.purpose`, errors, limits);
  if (hash && value.content_hash != null
    && (typeof value.content_hash !== 'string' || !SNAPSHOT_ID.test(value.content_hash))) {
    error(errors, `${path}.content_hash`, 'invalid-hash', 'must be a sha256 content hash or null');
  }
}

function validateSteps(steps, errors, limits) {
  if (!Array.isArray(steps)) return error(errors, '$.steps', 'invalid-type', 'must be an array');
  if (steps.length > limits.maxSteps) error(errors, '$.steps', 'too-many-items', `at most ${limits.maxSteps} steps`);
  steps.forEach((step, index) => {
    const path = `$.steps[${index}]`;
    if (!isObject(step)) return error(errors, path, 'invalid-type', 'must be an object');
    allowedKeys(step, path, ['id', 'parent_step_id', 'kind', 'status', 'target', 'goal', 'verify'], errors);
    required(step, path, ['id', 'parent_step_id', 'kind', 'status', 'target', 'goal', 'verify'], errors);
    prose(step.id, `${path}.id`, errors, limits);
    if (step.parent_step_id != null) prose(step.parent_step_id, `${path}.parent_step_id`, errors, limits);
    enumValue(step.kind, `${path}.kind`, STEP_KINDS, errors);
    enumValue(step.status, `${path}.status`, STEP_STATUSES, errors);
    validateTarget(step.target, `${path}.target`, errors, limits, { hash: true });
    prose(step.goal, `${path}.goal`, errors, limits);
    if (!isObject(step.verify)) {
      error(errors, `${path}.verify`, 'invalid-type', 'must be an object');
    } else {
      allowedKeys(step.verify, `${path}.verify`, ['command', 'expectation'], errors);
      if (typeof step.verify.command !== 'string' || !step.verify.command.length) {
        error(errors, `${path}.verify.command`, 'invalid-type', 'must be a non-empty string');
      } else if (step.verify.command.length > limits.maxCommandLength) {
        error(errors, `${path}.verify.command`, 'text-too-long', `at most ${limits.maxCommandLength} characters`);
      }
      prose(step.verify.expectation, `${path}.verify.expectation`, errors, limits);
    }
  });
}

function validateFrontier(value, errors, limits) {
  if (!isObject(value)) return error(errors, '$.frontier', 'invalid-type', 'must be an object');
  allowedKeys(value, '$.frontier', ['searched', 'ruled_out'], errors);
  required(value, '$.frontier', ['searched', 'ruled_out'], errors);
  boundedList(value.searched, '$.frontier.searched', ['query', 'scope', 'finding'], errors, limits);
  boundedList(value.ruled_out, '$.frontier.ruled_out', ['hypothesis', 'evidence'], errors, limits);
}

function boundedList(items, path, keys, errors, limits) {
  if (!Array.isArray(items)) return error(errors, path, 'invalid-type', 'must be an array');
  if (items.length > limits.maxFrontierItems) error(errors, path, 'too-many-items', `at most ${limits.maxFrontierItems} items`);
  items.forEach((item, index) => {
    if (!isObject(item)) return error(errors, `${path}[${index}]`, 'invalid-type', 'must be an object');
    allowedKeys(item, `${path}[${index}]`, keys, errors);
    for (const key of keys) prose(item[key], `${path}[${index}].${key}`, errors, limits);
  });
}

function validateValidation(value, errors, limits) {
  if (!isObject(value)) return error(errors, '$.validation', 'invalid-type', 'must be an object');
  allowedKeys(value, '$.validation', ['last_command', 'last_result', 'failing_tests', 'expected_after_next_step'], errors);
  required(value, '$.validation', ['last_command', 'last_result', 'failing_tests'], errors);
  if (value.last_command != null) {
    if (typeof value.last_command !== 'string') {
      error(errors, '$.validation.last_command', 'invalid-type', 'must be a string or null');
    } else if (value.last_command.length > limits.maxCommandLength) {
      error(errors, '$.validation.last_command', 'text-too-long', `at most ${limits.maxCommandLength} characters`);
    }
  }
  if (value.last_result != null) enumValue(value.last_result, '$.validation.last_result', RESULTS, errors);
  if (!Array.isArray(value.failing_tests)) {
    error(errors, '$.validation.failing_tests', 'invalid-type', 'must be an array');
  } else {
    if (value.failing_tests.length > limits.maxFailingTests) error(errors, '$.validation.failing_tests', 'too-many-items', `at most ${limits.maxFailingTests} names`);
    value.failing_tests.forEach((name, index) => prose(name, `$.validation.failing_tests[${index}]`, errors, limits));
  }
  if (value.expected_after_next_step != null) prose(value.expected_after_next_step, '$.validation.expected_after_next_step', errors, limits);
}

function validateNotes(notes, errors, limits) {
  if (!Array.isArray(notes)) return error(errors, '$.working_notes', 'invalid-type', 'must be an array');
  if (notes.length > limits.maxNotes) error(errors, '$.working_notes', 'too-many-items', `at most ${limits.maxNotes} notes`);
  notes.forEach((note, index) => {
    const path = `$.working_notes[${index}]`;
    if (!isObject(note)) return error(errors, path, 'invalid-type', 'must be an object');
    allowedKeys(note, path, ['text', 'created_at', 'expires_at'], errors);
    required(note, path, ['text', 'created_at', 'expires_at'], errors);
    if (typeof note.text !== 'string' || !note.text.length) {
      error(errors, `${path}.text`, 'invalid-type', 'must be a non-empty string');
    } else if (note.text.length > limits.maxNoteLength) {
      error(errors, `${path}.text`, 'text-too-long', `at most ${limits.maxNoteLength} characters`);
    }
    timestamp(note.created_at, `${path}.created_at`, errors);
    timestamp(note.expires_at, `${path}.expires_at`, errors);
  });
}

function validateIntegrity(value, errors, limits) {
  if (!isObject(value)) return error(errors, '$.integrity', 'invalid-type', 'must be an object');
  allowedKeys(value, '$.integrity', ['algorithm', 'digest', 'signature'], errors);
  required(value, '$.integrity', ['algorithm', 'digest', 'signature'], errors);
  if (value.algorithm !== 'sha256') error(errors, '$.integrity.algorithm', 'invalid-enum', 'algorithm must be sha256');
  if (typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest)) {
    error(errors, '$.integrity.digest', 'invalid-digest', 'must be 64 hex characters');
  }
  if (!isObject(value.signature)) {
    error(errors, '$.integrity.signature', 'invalid-type', 'must be an object');
  } else {
    allowedKeys(value.signature, '$.integrity.signature', ['status', 'algorithm', 'key_id', 'value'], errors);
    enumValue(value.signature.status, '$.integrity.signature.status', SIGNATURE_STATUSES, errors);
    if (value.signature.value != null) prose(value.signature.value, '$.integrity.signature.value', errors, limits);
  }
}

function validateGraph(envelope, errors) {
  if (!Array.isArray(envelope.steps) || !isObject(envelope.cursor)) return;
  const ids = new Set();
  const byId = new Map();
  const indexedSteps = [];
  envelope.steps.forEach((step, index) => {
    if (!isObject(step) || typeof step.id !== 'string') return;
    if (ids.has(step.id)) error(errors, `$.steps[${index}].id`, 'duplicate-id', `step id ${step.id} appears more than once`);
    ids.add(step.id);
    if (!byId.has(step.id)) byId.set(step.id, { step, index });
    indexedSteps.push({ step, index });
  });
  envelope.steps.forEach((step, index) => {
    if (!isObject(step) || step.parent_step_id == null) return;
    if (!ids.has(step.parent_step_id)) error(errors, `$.steps[${index}].parent_step_id`, 'dangling-step', 'parent_step_id does not name a step');
    if (step.parent_step_id === step.id) error(errors, `$.steps[${index}].parent_step_id`, 'self-parent', 'a step cannot be its own parent');
  });
  if (typeof envelope.cursor.step_id === 'string' && !ids.has(envelope.cursor.step_id)) {
    error(errors, '$.cursor.step_id', 'dangling-step', 'cursor.step_id does not name a step');
  }

  const currentSteps = indexedSteps.filter(({ step }) => step.status === 'current');
  if (currentSteps.length !== 1) {
    error(errors, '$.steps', 'invalid-current-count', 'execution state must contain exactly one current step');
  } else if (typeof envelope.cursor.step_id === 'string' && currentSteps[0].step.id !== envelope.cursor.step_id) {
    error(errors, '$.cursor.step_id', 'cursor-current-mismatch', 'cursor.step_id must name the current step');
  }

  const graphShapeValid = indexedSteps.length === envelope.steps.length
    && ids.size === envelope.steps.length
    && indexedSteps.every(({ step }) => step.parent_step_id === null
      || (typeof step.parent_step_id === 'string' && ids.has(step.parent_step_id) && step.parent_step_id !== step.id));
  if (!graphShapeValid) return;

  const roots = indexedSteps.filter(({ step }) => step.parent_step_id === null);
  if (roots.length !== 1) {
    error(errors, '$.steps', 'invalid-root-count', 'execution tree must contain exactly one root step');
  }
  for (const { step: start } of indexedSteps) {
    const ancestors = new Set();
    let current = byId.get(start.id);
    while (current?.step.parent_step_id !== null) {
      ancestors.add(current.step.id);
      const parent = byId.get(current.step.parent_step_id);
      if (ancestors.has(parent.step.id)) {
        error(errors, `$.steps[${current.index}].parent_step_id`, 'step-cycle', 'parent_step_id relationships must not contain a cycle');
        break;
      }
      current = parent;
    }
  }
}

// One pass over the whole tree: forbidden keys, control characters, and the
// payload prohibition that keeps checkpoints advisory.
function scanTree(value, path, errors, limits) {
  const pending = [{ value, path }];
  while (pending.length) {
    const { value: current, path: currentPath } = pending.pop();
    if (typeof current === 'string') {
      if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(current)) {
        error(errors, currentPath, 'control-character', 'text contains a forbidden control character');
      }
      if (PAYLOAD_PATTERNS.some((pattern) => pattern.test(current))
        || (current.split('\n').length - 1) > MAX_PROSE_NEWLINES) {
        error(errors, currentPath, 'payload-forbidden', 'execution state carries locations and goals, never code, diffs, or multi-line payloads');
      }
      continue;
    }
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) {
        pending.push({ value: current[index], path: `${currentPath}[${index}]` });
      }
      continue;
    }
    if (!isObject(current)) continue;
    const entries = Object.entries(current);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, child] = entries[index];
      if (key === '__proto__' || key === 'prototype' || key === 'constructor' || FORBIDDEN_KEY.test(key)) {
        error(errors, `${currentPath}.${key}`, 'forbidden-key', 'forbidden field in ACP execution state');
      }
      pending.push({ value: child, path: `${currentPath}.${key}` });
    }
  }
}

function buildRuntime(envelope, clock) {
  const byId = Object.create(null);
  for (const step of envelope.steps) byId[step.id] = step;
  const now = typeof clock === 'string' ? clock : new Date().toISOString();
  return {
    byId,
    currentStep: byId[envelope.cursor.step_id] ?? null,
    aged: envelope.expires_at < now,
  };
}

function normalizeEnvelope(value) {
  const root = normalizedValue(value);
  if (!root.container) return root.value;
  const pending = [{ source: value, target: root.value }];
  while (pending.length) {
    const { source, target } = pending.pop();
    const entries = Array.isArray(source)
      ? source.map((child, index) => [index, child])
      : Object.keys(source).sort().map((key) => [key.normalize('NFC'), source[key]]);
    for (const [key, child] of entries) {
      const normalized = normalizedValue(child);
      Object.defineProperty(target, key, { value: normalized.value, enumerable: true, configurable: true, writable: true });
      if (normalized.container) pending.push({ source: child, target: normalized.value });
    }
  }
  return root.value;
}

function normalizedValue(value) {
  if (Array.isArray(value)) return { value: [], container: true };
  if (isObject(value)) return { value: {}, container: true };
  return { value: typeof value === 'string' ? value.replace(/\r\n?/g, '\n').normalize('NFC') : value, container: false };
}

function prose(value, path, errors, limits) {
  if (typeof value !== 'string' || !value.length) {
    return error(errors, path, 'invalid-type', 'must be a non-empty string');
  }
  if (value.length > limits.maxProseLength) {
    error(errors, path, 'text-too-long', `at most ${limits.maxProseLength} characters`);
  }
}

function timestamp(value, path, errors) {
  if (!validTimestamp(value)) error(errors, path, 'invalid-timestamp', 'must be an ISO-8601 millisecond UTC timestamp');
}

function validTimestamp(value) {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function enumValue(value, path, allowed, errors) {
  if (!allowed.includes(value)) error(errors, path, 'invalid-enum', `must be one of: ${allowed.join(', ')}`);
}

function allowedKeys(value, path, allowed, errors) {
  if (!isObject(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) error(errors, `${path}.${key}`, 'additional-property', 'unknown property');
  }
}

function required(value, path, keys, errors) {
  if (!isObject(value)) return;
  for (const key of keys) {
    if (!(key in value)) error(errors, `${path}.${key}`, 'required', 'required property is missing');
  }
}

function error(errors, path, code, message) {
  errors.push({ path, code, message });
}

function orderErrors(errors) {
  const seen = new Set();
  return errors
    .sort((left, right) => compare(left.path, right.path) || compare(left.code, right.code))
    .filter((item) => {
      const key = `${item.path}\u0000${item.code}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function isObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
