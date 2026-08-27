import { createHash } from 'node:crypto';

function invalidCanonicalJson(cause) {
  return new Error('invalid-canonical-json', cause === undefined ? undefined : { cause });
}

function primitiveJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidCanonicalJson();
    return JSON.stringify(value);
  }
  return null;
}

// Iterative by design. Request hashing is a trust boundary and may be called by
// embedders as well as the validated MCP service; recursively descending a
// hostile 20,000-level object used to throw RangeError before the function
// could return its documented canonicalization error/result.
export function canonicalJson(value) {
  const output = [];
  const seen = new Set();
  const stack = [{ kind: 'value', value }];

  try {
    while (stack.length > 0) {
      const frame = stack.pop();
      if (frame.kind === 'raw') {
        output.push(frame.value);
        continue;
      }
      if (frame.kind === 'leave') {
        seen.delete(frame.value);
        continue;
      }

      const current = frame.value;
      const primitive = primitiveJson(current);
      if (primitive !== null) {
        output.push(primitive);
        continue;
      }

      if (Array.isArray(current)) {
        if (seen.has(current)) throw invalidCanonicalJson();
        for (let index = 0; index < current.length; index += 1) {
          // Array holes previously serialized as an empty field, making a
          // sparse one-element array collide with the empty array.
          if (!Object.hasOwn(current, index)) throw invalidCanonicalJson();
        }
        seen.add(current);
        output.push('[');
        stack.push({ kind: 'leave', value: current });
        stack.push({ kind: 'raw', value: ']' });
        for (let index = current.length - 1; index >= 0; index -= 1) {
          if (index < current.length - 1) stack.push({ kind: 'raw', value: ',' });
          stack.push({ kind: 'value', value: current[index] });
        }
        continue;
      }

      if (typeof current === 'object') {
        const prototype = Object.getPrototypeOf(current);
        if (seen.has(current) || (prototype !== Object.prototype && prototype !== null)) {
          throw invalidCanonicalJson();
        }
        seen.add(current);
        const keys = Object.keys(current).sort();
        output.push('{');
        stack.push({ kind: 'leave', value: current });
        stack.push({ kind: 'raw', value: '}' });
        for (let index = keys.length - 1; index >= 0; index -= 1) {
          const key = keys[index];
          if (index < keys.length - 1) stack.push({ kind: 'raw', value: ',' });
          stack.push({ kind: 'value', value: current[key] });
          stack.push({ kind: 'raw', value: ':' });
          stack.push({ kind: 'raw', value: JSON.stringify(key) });
        }
        continue;
      }

      throw invalidCanonicalJson();
    }
  } catch (error) {
    if (error?.message === 'invalid-canonical-json') throw error;
    throw invalidCanonicalJson(error);
  }

  return output.join('');
}

export function requestHash(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}
