import { createHash } from 'node:crypto';
import { createProjectState } from './project-state.js';

// The wire format is untrusted JSON. This module canonicalizes it, verifies its
// content-addressed integrity, and only then hands it to the domain constructor.
// Digest input deliberately excludes the fields derived from the digest itself
// (snapshot_id, integrity.digest) and the detached signature value.

class WireError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function canonicalize(value) {
  return serialize(value);
}

export function digestEnvelope(envelope) {
  return createHash('sha256').update(canonicalize(withoutDerivedFields(envelope)), 'utf8').digest('hex');
}

export function encodeEnvelope(state) {
  const envelope = structuredClone(state.envelope);
  const digest = digestEnvelope(envelope);
  envelope.snapshot_id = `sha256:${digest}`;
  envelope.integrity = { ...envelope.integrity, digest };
  return envelope;
}

export function decodeEnvelope(input, options = {}) {
  let envelope = input;
  if (typeof input === 'string') {
    try {
      envelope = JSON.parse(input);
    } catch {
      return { ok: false, errors: [{ path: '$', code: 'malformed-json', message: 'input is not valid JSON' }] };
    }
  }
  if (!isObject(envelope)) {
    return { ok: false, errors: [{ path: '$', code: 'invalid-type', message: 'envelope must be an object' }] };
  }
  const integrityErrors = verifyIntegrity(envelope);
  if (integrityErrors.length) return { ok: false, errors: integrityErrors };
  return createProjectState(envelope, options);
}

function verifyIntegrity(envelope) {
  let digest;
  try {
    digest = digestEnvelope(envelope);
  } catch (err) {
    return [{ path: '$', code: err.code ?? 'uncanonicalizable', message: err.message }];
  }
  const errors = [];
  if (envelope.integrity?.digest !== digest) {
    errors.push({ path: '$.integrity.digest', code: 'digest-mismatch', message: 'integrity digest does not match canonical content' });
  }
  if (envelope.snapshot_id !== `sha256:${digest}`) {
    errors.push({ path: '$.snapshot_id', code: 'snapshot-mismatch', message: 'snapshot_id does not match canonical digest' });
  }
  return errors;
}

function withoutDerivedFields(envelope) {
  const clone = structuredClone(envelope);
  if (!isObject(clone)) return clone;
  delete clone.snapshot_id;
  if (isObject(clone.integrity)) {
    delete clone.integrity.digest;
    if (isObject(clone.integrity.signature)) delete clone.integrity.signature.value;
  }
  return clone;
}

function serialize(value) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'string') return JSON.stringify(value.replace(/\r\n?/g, '\n').normalize('NFC'));
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'number') {
    if (!Number.isFinite(value)) throw new WireError('non-finite-number', 'numbers must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(serialize).join(',')}]`;
  if (isObject(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .map((key) => [key.normalize('NFC'), value[key]])
      .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
    return `{${keys.map(([key, child]) => `${JSON.stringify(key)}:${serialize(child)}`).join(',')}}`;
  }
  throw new WireError('unserializable', `cannot canonicalize value of type ${type}`);
}

function isObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
