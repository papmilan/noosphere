import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import { normalizeProjectText } from './normalization.js';
import { canonicalJson } from './stable-json.js';

const CURSOR_VERSION = 'v1';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

function invalidCursor() {
  throw new Error('invalid-cursor');
}

function assertCursorValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidCursor();
  const keys = Object.keys(value).sort();
  if (keys.length !== 4 || keys.join(',') !== 'after,operation,ownerScope,query') invalidCursor();
  if (typeof value.ownerScope !== 'string' || typeof value.operation !== 'string') invalidCursor();
  try {
    canonicalJson(value.query);
    canonicalJson(value.after);
  } catch {
    invalidCursor();
  }
}

function assertBinding(binding) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) invalidCursor();
  if (typeof binding.ownerScope !== 'string' || typeof binding.operation !== 'string') invalidCursor();
  try {
    canonicalJson(binding.query);
  } catch {
    invalidCursor();
  }
}

function cursorKey(secret) {
  let material;
  if (typeof secret === 'string') material = Buffer.from(secret, 'utf8');
  else if (Buffer.isBuffer(secret) || secret instanceof Uint8Array) material = Buffer.from(secret);
  else invalidCursor();
  if (material.length === 0) invalidCursor();
  return createHash('sha256').update(material).digest();
}

function normalizeQueryValue(value) {
  const root = normalizedQueryNode(value);
  if (!root.container) return root.value;
  const pending = [{ source: value, target: root.value }];
  while (pending.length > 0) {
    const { source, target } = pending.pop();
    const entries = Array.isArray(source)
      ? source.map((child, index) => [index, child])
      : Object.keys(source).map((key) => [key, source[key]]);
    for (const [key, child] of entries) {
      const normalized = normalizedQueryNode(child);
      // defineProperty treats "__proto__" as data rather than invoking the
      // legacy prototype setter on an ordinary object.
      Object.defineProperty(target, key, {
        value: normalized.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      if (normalized.container) pending.push({ source: child, target: normalized.value });
    }
  }
  return root.value;
}

function normalizedQueryNode(value) {
  if (typeof value === 'string') return { value: normalizeProjectText(value), container: false };
  if (Array.isArray(value)) return { value: [], container: true };
  if (value && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      return { value: {}, container: true };
    }
  }
  return { value, container: false };
}

function bindingDigest(binding, key) {
  return createHmac('sha256', key)
    .update(canonicalJson({
      ownerScope: binding.ownerScope,
      operation: binding.operation,
      query: normalizeQueryValue(binding.query),
    }))
    .digest();
}

function decodePart(value) {
  if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(value)) invalidCursor();
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) invalidCursor();
  return decoded;
}

function sameDigest(left, right) {
  return left.length === right.length && timingSafeEqual(left, right);
}

export function encodeCursor(value, secret) {
  assertCursorValue(value);
  const key = cursorKey(secret);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(canonicalJson({
    after: value.after,
    bindingDigest: bindingDigest(value, key).toString('base64url'),
  }), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [CURSOR_VERSION, iv.toString('base64url'), ciphertext.toString('base64url'), tag.toString('base64url')].join('.');
}

export function decodeCursor(cursor, binding, secret) {
  assertBinding(binding);
  const key = cursorKey(secret);
  if (typeof cursor !== 'string') invalidCursor();
  const parts = cursor.split('.');
  if (parts.length !== 4 || parts[0] !== CURSOR_VERSION) invalidCursor();

  const iv = decodePart(parts[1]);
  const ciphertext = decodePart(parts[2]);
  const tag = decodePart(parts[3]);
  if (iv.length !== IV_BYTES || tag.length !== AUTH_TAG_BYTES) invalidCursor();

  let value;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    value = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
  } catch {
    invalidCursor();
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidCursor();
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys.join(',') !== 'after,bindingDigest' || typeof value.bindingDigest !== 'string') invalidCursor();
  try {
    canonicalJson(value.after);
  } catch {
    invalidCursor();
  }

  let receivedDigest;
  try {
    receivedDigest = decodePart(value.bindingDigest);
  } catch {
    invalidCursor();
  }
  if (!sameDigest(receivedDigest, bindingDigest(binding, key))) invalidCursor();
  return { after: value.after };
}
