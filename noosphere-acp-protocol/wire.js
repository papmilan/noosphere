import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

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

const UTF8 = new TextDecoder('utf-8', { fatal: true });

export function canonicalize(value) {
  assertJsonWireValue(value);
  return serialize(value);
}

function assertJsonWireValue(value) {
  const [jsonError] = findJsonValueErrors(value);
  if (jsonError) throw new WireError(jsonError.code, jsonError.message);
  const [collision] = findNormalizedKeyCollisions(value);
  if (collision) {
    throw new WireError(
      'normalized-key-collision',
      `object keys collide after NFC normalization at ${collision.path}`,
    );
  }
}

export function findJsonValueErrors(value) {
  const errors = [];
  const active = new WeakSet();
  const pending = [{ kind: 'enter', value, path: '$' }];

  while (pending.length) {
    const item = pending.pop();
    if (item.kind === 'exit') {
      active.delete(item.value);
      continue;
    }

    const { value: current, path } = item;
    if (current === null || typeof current === 'string' || typeof current === 'boolean') continue;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) {
        errors.push({ path, code: 'non-finite-number', message: 'numbers must be finite' });
      }
      continue;
    }
    if (typeof current !== 'object') {
      errors.push({ path, code: 'non-json-value', message: `value of type ${typeof current} cannot appear in JSON` });
      continue;
    }
    if (!Array.isArray(current) && !isObject(current)) {
      errors.push({ path, code: 'non-json-value', message: 'only plain objects, arrays, and JSON scalar values are allowed' });
      continue;
    }
    if (active.has(current)) {
      errors.push({ path, code: 'cyclic-reference', message: 'cyclic references cannot appear in JSON' });
      continue;
    }

    active.add(current);
    pending.push({ kind: 'exit', value: current });
    if (Array.isArray(current)) {
      const ownKeys = Reflect.ownKeys(current);
      for (const key of ownKeys) {
        if (key === 'length') continue;
        if (typeof key !== 'string' || !isArrayIndex(key, current.length)) {
          errors.push({ path, code: 'non-json-array-property', message: 'arrays may only contain indexed JSON values' });
        }
      }
      for (let index = current.length - 1; index >= 0; index -= 1) {
        if (!Object.hasOwn(current, index)) {
          errors.push({ path: `${path}[${index}]`, code: 'sparse-array', message: 'sparse arrays are not valid ACP wire values' });
          continue;
        }
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
          errors.push({ path: `${path}[${index}]`, code: 'non-json-property', message: 'JSON values must use enumerable data properties' });
          continue;
        }
        pending.push({ kind: 'enter', value: descriptor.value, path: `${path}[${index}]` });
      }
      continue;
    }

    for (const key of Reflect.ownKeys(current)) {
      const keyPath = typeof key === 'string' ? `${path}[${JSON.stringify(key)}]` : path;
      if (typeof key !== 'string') {
        errors.push({ path: keyPath, code: 'non-json-property', message: 'symbol properties cannot appear in JSON' });
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
        errors.push({ path: keyPath, code: 'non-json-property', message: 'JSON values must use enumerable data properties' });
        continue;
      }
      pending.push({ kind: 'enter', value: descriptor.value, path: keyPath });
    }
  }

  return errors;
}

export function findNormalizedKeyCollisions(value) {
  const errors = [];
  const pending = [{ value, path: '$' }];
  const visited = new WeakSet();

  while (pending.length) {
    const { value: current, path } = pending.pop();
    if (current === null || typeof current !== 'object') continue;
    if (visited.has(current)) continue;
    visited.add(current);

    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) {
        pending.push({ value: current[index], path: `${path}[${index}]` });
      }
      continue;
    }
    if (!isObject(current)) continue;

    const normalizedKeys = new Map();
    for (const key of Object.keys(current)) {
      const normalizedKey = key.normalize('NFC');
      const previous = normalizedKeys.get(normalizedKey);
      if (previous !== undefined) {
        errors.push({
          path: `${path}[${JSON.stringify(key)}]`,
          code: 'normalized-key-collision',
          message: `object keys ${JSON.stringify(previous)} and ${JSON.stringify(key)} collide after NFC normalization`,
        });
      } else {
        normalizedKeys.set(normalizedKey, key);
      }
      pending.push({ value: current[key], path: `${path}[${JSON.stringify(key)}]` });
    }
  }

  return errors;
}

export function digestEnvelope(envelope) {
  assertJsonWireValue(envelope);
  return createHash('sha256').update(serialize(withoutDerivedFields(envelope)), 'utf8').digest('hex');
}

export function encodeEnvelope(state) {
  const digest = digestEnvelope(state.envelope);
  const envelope = structuredClone(state.envelope);
  envelope.snapshot_id = `sha256:${digest}`;
  envelope.integrity = { ...envelope.integrity, digest };
  return envelope;
}

export function decodeEnvelope(input, { construct = (envelope) => ({ ok: true, envelope }), ...options } = {}) {
  let envelope = input;
  if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
    try {
      const bytes = input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      envelope = UTF8.decode(bytes);
    } catch {
      return { ok: false, errors: [{ path: '$', code: 'invalid-utf8', message: 'input is not valid UTF-8' }] };
    }
  }
  if (typeof envelope === 'string') {
    try {
      envelope = JSON.parse(envelope);
    } catch {
      return { ok: false, errors: [{ path: '$', code: 'malformed-json', message: 'input is not valid JSON' }] };
    }
  }
  if (!isObject(envelope)) {
    return { ok: false, errors: [{ path: '$', code: 'invalid-type', message: 'envelope must be an object' }] };
  }
  const integrityErrors = verifyIntegrity(envelope);
  if (integrityErrors.length) return { ok: false, errors: integrityErrors };
  return construct(envelope, options);
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
  if (!isObject(envelope)) return envelope;
  const { snapshot_id: _snapshotId, integrity, ...body } = envelope;
  if (!isObject(integrity)) return { ...body, integrity };
  const { digest: _digest, signature, ...integrityBody } = integrity;
  if (!isObject(signature)) return { ...body, integrity: { ...integrityBody, signature } };
  const { value: _signatureValue, ...signatureBody } = signature;
  return { ...body, integrity: { ...integrityBody, signature: signatureBody } };
}

function serialize(value) {
  const output = [];
  const pending = [{ kind: 'value', value }];
  while (pending.length) {
    const item = pending.pop();
    if (item.kind === 'token') {
      output.push(item.value);
      continue;
    }
    const current = item.value;
    if (current === null) {
      output.push('null');
    } else if (typeof current === 'string') {
      output.push(JSON.stringify(current.replace(/\r\n?/g, '\n').normalize('NFC')));
    } else if (typeof current === 'boolean') {
      output.push(current ? 'true' : 'false');
    } else if (typeof current === 'number') {
      output.push(JSON.stringify(current));
    } else if (Array.isArray(current)) {
      output.push('[');
      pending.push({ kind: 'token', value: ']' });
      for (let index = current.length - 1; index >= 0; index -= 1) {
        pending.push({ kind: 'value', value: current[index] });
        if (index > 0) pending.push({ kind: 'token', value: ',' });
      }
    } else {
      output.push('{');
      pending.push({ kind: 'token', value: '}' });
      const entries = Object.keys(current)
        .map((key) => [key.normalize('NFC'), current[key]])
        .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, child] = entries[index];
        pending.push({ kind: 'value', value: child });
        pending.push({ kind: 'token', value: ':' });
        pending.push({ kind: 'token', value: JSON.stringify(key) });
        if (index > 0) pending.push({ kind: 'token', value: ',' });
      }
    }
  }
  return output.join('');
}

function isArrayIndex(key, length) {
  if (!/^(?:0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function isObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
