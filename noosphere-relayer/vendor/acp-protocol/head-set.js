import { createHash } from 'node:crypto';
import { canonicalize } from './wire.js';

const SNAPSHOT_ID = /^sha256:[0-9a-f]{64}$/;

export function normalizeHeadIds(ids) {
  if (!Array.isArray(ids)) throw new Error('invalid-head-set');
  const sorted = [...ids].sort();
  if (sorted.some((id) => !SNAPSHOT_ID.test(id))) throw new Error('invalid-head-id');
  if (sorted.some((id, index) => index > 0 && id === sorted[index - 1])) throw new Error('duplicate-head');
  return sorted;
}

export function digestHeadSet(ids) {
  const bytes = canonicalize(normalizeHeadIds(ids));
  return `sha256:${createHash('sha256').update(bytes, 'utf8').digest('hex')}`;
}
