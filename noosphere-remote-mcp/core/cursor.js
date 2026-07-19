import { canonicalJson } from './stable-json.js';

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

export function encodeCursor(value) {
  assertCursorValue(value);
  return Buffer.from(canonicalJson({
    ownerScope: value.ownerScope,
    operation: value.operation,
    query: value.query,
    after: value.after,
  })).toString('base64url');
}

export function decodeCursor(cursor, binding) {
  if (typeof cursor !== 'string' || cursor.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) invalidCursor();
  let value;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    if (Buffer.from(decoded).toString('base64url') !== cursor) invalidCursor();
    value = JSON.parse(decoded);
  } catch {
    invalidCursor();
  }
  assertCursorValue(value);
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) invalidCursor();
  if (value.ownerScope !== binding.ownerScope || value.operation !== binding.operation) invalidCursor();
  try {
    if (canonicalJson(value.query) !== canonicalJson(binding.query)) invalidCursor();
  } catch {
    invalidCursor();
  }
  return { after: value.after };
}
