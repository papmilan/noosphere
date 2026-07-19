import { createHash } from 'node:crypto';

function canonicalize(value, seen) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('invalid-canonical-json');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error('invalid-canonical-json');
    seen.add(value);
    const result = `[${value.map((item) => canonicalize(item, seen)).join(',')}]`;
    seen.delete(value);
    return result;
  }
  if (typeof value === 'object') {
    if (seen.has(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('invalid-canonical-json');
    seen.add(value);
    const result = `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key], seen)}`).join(',')}}`;
    seen.delete(value);
    return result;
  }
  throw new Error('invalid-canonical-json');
}

export function canonicalJson(value) {
  return canonicalize(value, new Set());
}

export function requestHash(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}
