export const ACP_PROTOCOL = 'acp.project-state-envelope';
export const ACP_SCHEMA_VERSION = '1.0.0';

const ASSERTION_TYPES = [
  'plan',
  'completed_work',
  'decisions',
  'evidence',
  'assumptions',
  'rejected_approaches',
  'unknowns',
  'blockers',
  'risks',
  'next_actions',
];
const FORBIDDEN_KEY = /(?:chain[ _-]?of[ _-]?thought|hidden[ _-]?reasoning|token[ _-]?(?:trace|traces)|(?:secret|credential|password|api[ _-]?key|access[ _-]?token)|provider[ _-]?(?:state|internal)|raw[ _-]?chat|session[ _-]?state)/i;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EXTENSION_KEY = /^(?:[a-z][a-z0-9-]*\.)+[a-z][a-z0-9-]*$/;

export const defaultPolicy = Object.freeze({
  maxTextLength: 4_000,
  maxCollectionSize: 100,
  maxExtensionKeys: 20,
  maxExtensionDepth: 10,
});

export function createProjectState(envelope, { clock, policy = defaultPolicy } = {}) {
  const errors = validateEnvelope(envelope, policy);
  if (errors.length) return { ok: false, errors: orderErrors(errors) };

  const normalized = normalizeEnvelope(envelope);
  const runtime = buildIndexes(normalized, clock);
  if (runtime.errors.length) return { ok: false, errors: orderErrors(runtime.errors) };

  return {
    ok: true,
    state: Object.freeze({
      envelope: deepFreeze(normalized),
      runtime: deepFreeze(runtime.value),
    }),
  };
}

function validateEnvelope(envelope, policy) {
  const errors = [];
  const limits = normalizePolicy(policy);
  validateForbiddenKeys(envelope, '$', errors, limits);
  if (!isObject(envelope)) return errors;

  validateObject(envelope, '$', [
    'protocol', 'schema_version', 'snapshot_id', 'parent_snapshot_id', 'created_at',
    'expires_at', 'origin', 'integrity', 'permission_scope', 'trust', 'repository',
    'phase', 'goal', 'plan', 'completed_work', 'decisions', 'evidence', 'assumptions',
    'rejected_approaches', 'unknowns', 'blockers', 'risks', 'conflicts',
    'working_stance', 'next_actions', 'references', 'extensions',
  ], errors);

  required(envelope, '$', [
    'protocol', 'schema_version', 'snapshot_id', 'created_at', 'origin', 'integrity',
    'permission_scope', 'trust', 'repository', 'phase', 'goal', 'plan', 'completed_work',
    'decisions', 'evidence', 'assumptions', 'rejected_approaches', 'unknowns',
    'blockers', 'risks', 'conflicts', 'working_stance', 'next_actions', 'references',
    'extensions',
  ], errors);
  equals(envelope.protocol, ACP_PROTOCOL, '$.protocol', 'invalid-protocol', errors);
  equals(envelope.schema_version, ACP_SCHEMA_VERSION, '$.schema_version', 'unsupported-version', errors);
  string(envelope.snapshot_id, '$.snapshot_id', errors, limits, /^sha256:[a-f0-9]{64}$/);
  nullableString(envelope.parent_snapshot_id, '$.parent_snapshot_id', errors, limits, /^sha256:[a-f0-9]{64}$/);
  if (envelope.parent_snapshot_id === envelope.snapshot_id) error(errors, '$.parent_snapshot_id', 'self-parent', 'parent_snapshot_id must differ from snapshot_id');
  timestamp(envelope.created_at, '$.created_at', errors);
  nullableTimestamp(envelope.expires_at, '$.expires_at', errors);
  if (validTimestamp(envelope.created_at) && validTimestamp(envelope.expires_at) && envelope.expires_at < envelope.created_at) error(errors, '$.expires_at', 'invalid-expiry', 'expires_at must not be before created_at');

  validateOrigin(envelope.origin, errors, limits);
  validateIntegrity(envelope.integrity, errors, limits);
  enumValue(envelope.permission_scope, '$.permission_scope', ['project'], errors);
  validateTrust(envelope.trust, errors, limits);
  validateRepository(envelope.repository, errors, limits);
  enumValue(envelope.phase, '$.phase', ['discovery', 'planning', 'implementation', 'verification', 'blocked', 'complete'], errors);
  validateGoal(envelope.goal, errors, limits);
  validateWorkingStance(envelope.working_stance, errors, limits);

  for (const type of ASSERTION_TYPES) validateAssertions(envelope[type], `$.${type}`, type, errors, limits);
  validateConflicts(envelope.conflicts, errors, limits);
  validateReferences(envelope.references, errors, limits);
  validateExtensions(envelope.extensions, errors, limits);
  validateIdentityAndProvenance(envelope, errors);
  return errors;
}

function validateOrigin(value, errors, limits) {
  validateObject(value, '$.origin', ['agent_id', 'client', 'session_id'], errors);
  required(value, '$.origin', ['agent_id', 'client', 'session_id'], errors);
  string(value?.agent_id, '$.origin.agent_id', errors, limits);
  string(value?.client, '$.origin.client', errors, limits);
  nullableString(value?.session_id, '$.origin.session_id', errors, limits);
}

function validateIntegrity(value, errors, limits) {
  validateObject(value, '$.integrity', ['algorithm', 'digest', 'signature'], errors);
  required(value, '$.integrity', ['algorithm', 'digest', 'signature'], errors);
  enumValue(value?.algorithm, '$.integrity.algorithm', ['sha256'], errors);
  string(value?.digest, '$.integrity.digest', errors, limits, /^[a-f0-9]{64}$/);
  validateObject(value?.signature, '$.integrity.signature', ['status', 'algorithm', 'key_id', 'value'], errors);
  required(value?.signature, '$.integrity.signature', ['status', 'algorithm', 'key_id', 'value'], errors);
  enumValue(value?.signature?.status, '$.integrity.signature.status', ['unsigned', 'signed'], errors);
  nullableString(value?.signature?.algorithm, '$.integrity.signature.algorithm', errors, limits);
  nullableString(value?.signature?.key_id, '$.integrity.signature.key_id', errors, limits);
  nullableString(value?.signature?.value, '$.integrity.signature.value', errors, limits);
}

function validateTrust(value, errors, limits) {
  validateObject(value, '$.trust', ['level', 'reasons'], errors);
  required(value, '$.trust', ['level', 'reasons'], errors);
  enumValue(value?.level, '$.trust.level', ['local-unverified', 'local-verified', 'shared-unverified', 'shared-verified'], errors);
  strings(value?.reasons, '$.trust.reasons', errors, limits);
}

function validateRepository(value, errors, limits) {
  validateObject(value, '$.repository', ['project_id', 'root_identity', 'head', 'branch', 'merge_base', 'dirty', 'workspace_fingerprint'], errors);
  required(value, '$.repository', ['project_id', 'root_identity', 'head', 'branch', 'merge_base', 'dirty', 'workspace_fingerprint'], errors);
  string(value?.project_id, '$.repository.project_id', errors, limits);
  string(value?.root_identity, '$.repository.root_identity', errors, limits, /^sha256:[a-f0-9]{64}$/);
  nullableString(value?.head, '$.repository.head', errors, limits);
  nullableString(value?.branch, '$.repository.branch', errors, limits);
  nullableString(value?.merge_base, '$.repository.merge_base', errors, limits);
  if (typeof value?.dirty !== 'boolean') error(errors, '$.repository.dirty', 'invalid-type', 'dirty must be a boolean');
  string(value?.workspace_fingerprint, '$.repository.workspace_fingerprint', errors, limits, /^sha256:[a-f0-9]{64}$/);
}

function validateGoal(value, errors, limits) {
  validateObject(value, '$.goal', ['project', 'current_objective', 'success_conditions'], errors);
  required(value, '$.goal', ['project', 'current_objective', 'success_conditions'], errors);
  string(value?.project, '$.goal.project', errors, limits);
  string(value?.current_objective, '$.goal.current_objective', errors, limits);
  strings(value?.success_conditions, '$.goal.success_conditions', errors, limits);
}

function validateWorkingStance(value, errors, limits) {
  validateObject(value, '$.working_stance', ['confidence', 'momentum', 'risk_posture', 'attention', 'dissatisfaction', 'successor_behavior'], errors);
  required(value, '$.working_stance', ['confidence', 'momentum', 'risk_posture', 'attention', 'dissatisfaction', 'successor_behavior'], errors);
  enumValue(value?.confidence, '$.working_stance.confidence', ['low', 'medium', 'high'], errors);
  enumValue(value?.momentum, '$.working_stance.momentum', ['progressing', 'stalled', 'regressing', 'unknown'], errors);
  enumValue(value?.risk_posture, '$.working_stance.risk_posture', ['safe-changes-only', 'verify-before-change', 'exploration-allowed', 'implementation-ready'], errors);
  strings(value?.attention, '$.working_stance.attention', errors, limits);
  strings(value?.dissatisfaction, '$.working_stance.dissatisfaction', errors, limits);
  strings(value?.successor_behavior, '$.working_stance.successor_behavior', errors, limits);
}

function validateAssertions(items, path, type, errors, limits) {
  if (!Array.isArray(items)) return error(errors, path, 'invalid-type', 'must be an array');
  if (items.length > limits.maxCollectionSize) error(errors, path, 'collection-too-large', 'collection exceeds policy limit');
  items.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    const allowed = type === 'decisions'
      ? ['id', 'text', 'domain', 'status', 'confidence', 'provenance', 'created_at', 'expires_at', 'repository_fingerprint', 'supersedes']
      : ['id', 'text', 'status', 'confidence', 'provenance', 'created_at', 'expires_at', 'repository_fingerprint', 'supersedes', 'priority'];
    validateObject(item, itemPath, allowed, errors);
    required(item, itemPath, ['id', 'text', 'confidence', 'provenance', 'created_at', 'repository_fingerprint', 'supersedes'], errors);
    string(item?.id, `${itemPath}.id`, errors, limits);
    string(item?.text, `${itemPath}.text`, errors, limits);
    if (type === 'decisions') string(item?.domain, `${itemPath}.domain`, errors, limits);
    if (item?.status !== undefined) enumValue(item.status, `${itemPath}.status`, assertionStatuses(type), errors);
    enumValue(item?.confidence, `${itemPath}.confidence`, ['low', 'medium', 'high'], errors);
    strings(item?.provenance, `${itemPath}.provenance`, errors, limits);
    timestamp(item?.created_at, `${itemPath}.created_at`, errors);
    nullableTimestamp(item?.expires_at, `${itemPath}.expires_at`, errors);
    if (validTimestamp(item?.created_at) && validTimestamp(item?.expires_at) && item.expires_at < item.created_at) error(errors, `${itemPath}.expires_at`, 'invalid-expiry', 'expires_at must not be before created_at');
    nullableString(item?.repository_fingerprint, `${itemPath}.repository_fingerprint`, errors, limits, /^sha256:[a-f0-9]{64}$/);
    strings(item?.supersedes, `${itemPath}.supersedes`, errors, limits);
    if (Array.isArray(item?.supersedes) && item.supersedes.includes(item.id)) error(errors, `${itemPath}.supersedes`, 'self-supersession', 'an assertion cannot supersede itself');
    if (item?.priority !== undefined && (!Number.isInteger(item.priority) || item.priority < 1)) error(errors, `${itemPath}.priority`, 'invalid-priority', 'priority must be a positive integer');
  });
}

function validateReferences(items, errors, limits) {
  if (!Array.isArray(items)) return error(errors, '$.references', 'invalid-type', 'must be an array');
  if (items.length > limits.maxCollectionSize) error(errors, '$.references', 'collection-too-large', 'collection exceeds policy limit');
  items.forEach((item, index) => {
    const path = `$.references[${index}]`;
    validateObject(item, path, ['id', 'kind', 'locator'], errors);
    required(item, path, ['id', 'kind', 'locator'], errors);
    string(item?.id, `${path}.id`, errors, limits);
    enumValue(item?.kind, `${path}.kind`, ['file', 'commit', 'command', 'test', 'journal', 'user-instruction', 'external'], errors);
    string(item?.locator, `${path}.locator`, errors, limits);
  });
}

function validateExtensions(value, errors, limits) {
  if (!isObject(value)) return error(errors, '$.extensions', 'invalid-type', 'must be an object');
  const keys = Object.keys(value);
  if (keys.length > limits.maxExtensionKeys) error(errors, '$.extensions', 'collection-too-large', 'extensions exceed policy limit');
  for (const key of keys) {
    if (!EXTENSION_KEY.test(key)) error(errors, `$.extensions.${key}`, 'invalid-extension-key', 'extension keys must be namespaced');
    validateExtensionValue(value[key], `$.extensions.${key}`, errors, limits, 1);
  }
}

function validateExtensionValue(value, path, errors, limits, depth) {
  if (depth > limits.maxExtensionDepth) return error(errors, path, 'extension-too-deep', 'extension nesting exceeds policy limit');
  if (typeof value === 'string') {
    if (value.length > limits.maxTextLength) error(errors, path, 'text-too-large', 'text exceeds policy limit');
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > limits.maxCollectionSize) error(errors, path, 'collection-too-large', 'collection exceeds policy limit');
    value.forEach((item, index) => validateExtensionValue(item, `${path}[${index}]`, errors, limits, depth + 1));
    return;
  }
  if (!isObject(value)) return;
  const keys = Object.keys(value);
  if (keys.length > limits.maxExtensionKeys) error(errors, path, 'collection-too-large', 'extension object exceeds policy limit');
  for (const key of keys) validateExtensionValue(value[key], `${path}.${key}`, errors, limits, depth + 1);
}

function validateConflicts(items, errors, limits) {
  if (!Array.isArray(items)) return error(errors, '$.conflicts', 'invalid-type', 'must be an array');
  if (items.length > limits.maxCollectionSize) error(errors, '$.conflicts', 'collection-too-large', 'collection exceeds policy limit');
  items.forEach((conflict, index) => {
    const path = `$.conflicts[${index}]`;
    validateObject(conflict, path, ['kind', 'severity', 'status', 'domain', 'candidates'], errors);
    required(conflict, path, ['kind', 'severity', 'status', 'candidates'], errors);
    string(conflict?.kind, `${path}.kind`, errors, limits);
    enumValue(conflict?.severity, `${path}.severity`, ['low', 'medium', 'high'], errors);
    enumValue(conflict?.status, `${path}.status`, ['unresolved', 'resolved'], errors);
    if (conflict?.domain !== undefined) string(conflict.domain, `${path}.domain`, errors, limits);
    if (!Array.isArray(conflict?.candidates)) {
      error(errors, `${path}.candidates`, 'invalid-type', 'must be an array');
      return;
    }
    if (conflict.candidates.length < 1) error(errors, `${path}.candidates`, 'invalid-size', 'must include at least one candidate');
    if (conflict.candidates.length > limits.maxCollectionSize) error(errors, `${path}.candidates`, 'collection-too-large', 'collection exceeds policy limit');
    conflict.candidates.forEach((candidate, candidateIndex) => validateConflictCandidate(candidate, `${path}.candidates[${candidateIndex}]`, errors, limits));
  });
}

function validateConflictCandidate(candidate, path, errors, limits) {
  validateObject(candidate, path, ['assertion_id', 'value', 'provenance', 'repository_binding', 'trust', 'created_at', 'expires_at'], errors);
  required(candidate, path, ['assertion_id', 'value', 'provenance', 'repository_binding', 'trust', 'created_at'], errors);
  string(candidate?.assertion_id, `${path}.assertion_id`, errors, limits);
  string(candidate?.value, `${path}.value`, errors, limits);
  strings(candidate?.provenance, `${path}.provenance`, errors, limits);
  nullableString(candidate?.repository_binding, `${path}.repository_binding`, errors, limits, /^sha256:[a-f0-9]{64}$/);
  enumValue(candidate?.trust, `${path}.trust`, ['local-unverified', 'local-verified', 'shared-unverified', 'shared-verified'], errors);
  timestamp(candidate?.created_at, `${path}.created_at`, errors);
  nullableTimestamp(candidate?.expires_at, `${path}.expires_at`, errors);
  if (validTimestamp(candidate?.created_at) && validTimestamp(candidate?.expires_at) && candidate.expires_at < candidate.created_at) error(errors, `${path}.expires_at`, 'invalid-expiry', 'expires_at must not be before created_at');
}

function validateIdentityAndProvenance(envelope, errors) {
  const ids = new Map();
  const known = new Set();
  for (const reference of envelope.references ?? []) {
    recordId(reference?.id, '$.references', ids, errors);
    if (typeof reference?.id === 'string') known.add(reference.id);
  }
  for (const type of ASSERTION_TYPES) {
    for (const assertion of envelope[type] ?? []) {
      recordId(assertion?.id, `$.${type}`, ids, errors);
      if (type === 'evidence' && typeof assertion?.id === 'string') known.add(assertion.id);
    }
  }
  for (const type of ASSERTION_TYPES) {
    for (const [index, assertion] of (envelope[type] ?? []).entries()) {
      for (const [provenanceIndex, referenceId] of (assertion?.provenance ?? []).entries()) {
        if (typeof referenceId === 'string' && !known.has(referenceId)) error(errors, `$.${type}[${index}].provenance[${provenanceIndex}]`, 'dangling-provenance', 'provenance must resolve to a reference or evidence ID');
      }
    }
  }
  for (const [conflictIndex, conflict] of (envelope.conflicts ?? []).entries()) {
    for (const [candidateIndex, candidate] of (conflict?.candidates ?? []).entries()) {
      for (const [provenanceIndex, referenceId] of (candidate?.provenance ?? []).entries()) {
        if (typeof referenceId === 'string' && !known.has(referenceId)) error(errors, `$.conflicts[${conflictIndex}].candidates[${candidateIndex}].provenance[${provenanceIndex}]`, 'dangling-provenance', 'provenance must resolve to a reference or evidence ID');
      }
    }
  }
}

function buildIndexes(envelope, clock) {
  const errors = [];
  if (!validTimestamp(clock)) {
    error(errors, '$.clock', 'invalid-timestamp', 'clock must be a UTC RFC 3339 timestamp with milliseconds');
    return { errors, value: null };
  }
  const byId = Object.create(null);
  const referencesById = Object.create(null);
  const activeByType = Object.assign(Object.create(null), Object.fromEntries(ASSERTION_TYPES.map((type) => [type, []])));
  const activeDecisionsByDomain = Object.create(null);
  const superseded = new Set();

  for (const type of ASSERTION_TYPES) for (const item of envelope[type]) for (const id of item.supersedes) superseded.add(id);
  for (const reference of envelope.references) referencesById[reference.id] = reference;
  for (const type of ASSERTION_TYPES) {
    for (const item of envelope[type]) {
      byId[item.id] = item;
      if (!isActive(item, superseded, clock)) continue;
      activeByType[type].push(item.id);
      if (type === 'decisions') (activeDecisionsByDomain[item.domain] ??= []).push(item.id);
    }
  }
  for (const ids of Object.values(activeByType)) ids.sort();
  for (const ids of Object.values(activeDecisionsByDomain)) ids.sort();

  const conflicts = Object.keys(activeDecisionsByDomain).sort().flatMap((domain) => {
    const assertionIds = activeDecisionsByDomain[domain];
    return assertionIds.length > 1 ? [{
      kind: 'decision-domain',
      severity: 'high',
      status: 'unresolved',
      domain,
      candidates: assertionIds.map((id) => conflictCandidate(byId[id], envelope.trust.level)),
    }] : [];
  });
  return { errors, value: { byId, referencesById, activeByType, activeDecisionsByDomain, conflicts } };
}

function isActive(item, superseded, clock) {
  return item.status !== 'superseded' && item.status !== 'resolved' && item.status !== 'rejected' && item.status !== 'completed' && item.status !== 'blocked' && !superseded.has(item.id) && (item.expires_at == null || item.expires_at > clock);
}

function conflictCandidate(item, trust) {
  return {
    assertion_id: item.id,
    value: item.text,
    provenance: item.provenance,
    repository_binding: item.repository_fingerprint,
    trust,
    created_at: item.created_at,
    expires_at: item.expires_at ?? null,
  };
}

function normalizeEnvelope(value) {
  if (Array.isArray(value)) return value.map(normalizeEnvelope);
  if (!isObject(value)) return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').normalize('NFC') : value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key.normalize('NFC'), normalizeEnvelope(value[key]) ]));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function normalizePolicy(policy) {
  return {
    maxTextLength: positiveInteger(policy?.maxTextLength, defaultPolicy.maxTextLength),
    maxCollectionSize: positiveInteger(policy?.maxCollectionSize, defaultPolicy.maxCollectionSize),
    maxExtensionKeys: positiveInteger(policy?.maxExtensionKeys, defaultPolicy.maxExtensionKeys),
    maxExtensionDepth: positiveInteger(policy?.maxExtensionDepth, defaultPolicy.maxExtensionDepth),
  };
}

function assertionStatuses(type) {
  if (type === 'decisions') return ['proposed', 'active', 'superseded', 'rejected', 'resolved'];
  if (type === 'plan' || type === 'next_actions') return ['planned', 'in_progress', 'completed', 'blocked', 'superseded'];
  return ['active', 'resolved', 'superseded', 'rejected'];
}

function validateForbiddenKeys(value, path, errors, limits) {
  if (typeof value === 'string') {
    if (value.length > limits.maxTextLength) error(errors, path, 'text-too-large', 'text exceeds policy limit');
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) error(errors, path, 'control-character', 'text contains a forbidden control character');
    return;
  }
  if (Array.isArray(value)) return value.forEach((item, index) => validateForbiddenKeys(item, `${path}[${index}]`, errors, limits));
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor' || FORBIDDEN_KEY.test(key)) error(errors, `${path}.${key}`, 'forbidden-key', 'forbidden field in ACP project state');
    validateForbiddenKeys(child, `${path}.${key}`, errors, limits);
  }
}

function validateObject(value, path, allowed, errors) {
  if (!isObject(value)) return error(errors, path, 'invalid-type', 'must be an object');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) error(errors, `${path}.${key}`, 'additional-property', 'unknown property');
}
function required(value, path, keys, errors) {
  if (!isObject(value)) return;
  for (const key of keys) if (!(key in value)) error(errors, `${path}.${key}`, 'required', 'required property is missing');
}
function string(value, path, errors, limits, pattern) {
  if (typeof value !== 'string' || value.length === 0) return error(errors, path, 'invalid-string', 'must be a non-empty string');
  if (value.length > limits.maxTextLength) error(errors, path, 'text-too-large', 'text exceeds policy limit');
  if (pattern && !pattern.test(value)) error(errors, path, 'invalid-format', 'value has an invalid format');
}
function nullableString(value, path, errors, limits, pattern) {
  if (value === null || value === undefined) return;
  string(value, path, errors, limits, pattern);
}
function strings(value, path, errors, limits) {
  if (!Array.isArray(value)) return error(errors, path, 'invalid-type', 'must be an array');
  if (value.length > limits.maxCollectionSize) error(errors, path, 'collection-too-large', 'collection exceeds policy limit');
  value.forEach((item, index) => string(item, `${path}[${index}]`, errors, limits));
}
function timestamp(value, path, errors) {
  if (!validTimestamp(value)) error(errors, path, 'invalid-timestamp', 'must be a UTC RFC 3339 timestamp with milliseconds');
}
function nullableTimestamp(value, path, errors) { if (value !== null && value !== undefined) timestamp(value, path, errors); }
function validTimestamp(value) {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}
function enumValue(value, path, allowed, errors) { if (!allowed.includes(value)) error(errors, path, 'invalid-enum', `must be one of: ${allowed.join(', ')}`); }
function equals(value, expected, path, code, errors) { if (value !== expected) error(errors, path, code, `must equal ${expected}`); }
function recordId(id, path, ids, errors) {
  if (typeof id !== 'string') return;
  if (ids.has(id)) error(errors, path, 'duplicate-id', `duplicate stable ID: ${id}`);
  else ids.set(id, path);
}
function positiveInteger(value, fallback) { return Number.isInteger(value) && value > 0 ? value : fallback; }
function isObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function error(errors, path, code, message) { errors.push({ path, code, message }); }
function orderErrors(errors) {
  return errors.sort((left, right) => compareText(left.path, right.path) || compareText(left.code, right.code));
}
function compareText(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
