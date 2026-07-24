// SEC-05 Phase 4A-R1 — strict exact-schema parser for authenticated records.
//
// INTERNAL, non-exported. Every authenticated Phase-4 record (slot record,
// manifest, audit event, journal, project binding, serialized lock metadata) is
// decoded through parseAuthenticatedRecord so ambiguity is rejected before the
// MAC is even considered:
//   - a per-record size cap enforced BEFORE decode/parse;
//   - fatal UTF-8 decoding (no silent U+FFFD substitution);
//   - explicit BOM rejection;
//   - duplicate-key rejection (a reviver, since JSON.parse silently keeps last);
//   - canonical-byte reserialization equality (ordering / whitespace / dup keys);
//   - format/type/domain match;
//   - exact per-field validators, and rejection of any unknown field.
//
// Native JSON.parse alone is insufficient (it accepts duplicate keys, arbitrary
// key order, and does not bound size), which is why this layer exists.
import { TrustStoreError, canonicalize } from '../trust-store-internal.js';

const HEX64 = /^[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;

// Field validators. Each returns true for an acceptable value.
export const is = Object.freeze({
  uuid: (v) => typeof v === 'string' && UUID_V4.test(v),
  hex64: (v) => typeof v === 'string' && HEX64.test(v),
  str: (v) => typeof v === 'string',
  nonNegInt: (v) => Number.isSafeInteger(v) && v >= 0,
  posInt: (v) => Number.isSafeInteger(v) && v >= 1,
  enumOf: (set) => (v) => typeof v === 'string' && set.has(v),
  intEquals: (n) => (v) => v === n,
  nullable: (inner) => (v) => v === null || inner(v),
  rfc3339utc: (v) => {
    if (typeof v !== 'string') return false;
    const m = RFC3339.exec(v);
    if (!m) return false;
    const [, , mo, d, h, mi, s] = m.map(Number);
    return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && h <= 23 && mi <= 59 && s <= 59;
  },
});

// Decode + structurally validate. Throws TrustStoreError; never returns partial.
export function parseAuthenticatedRecord(raw, { type, maxBytes, schema }) {
  if (!Buffer.isBuffer(raw)) throw new TrustStoreError('record-corrupt', `${type} must be raw bytes`);
  if (raw.length > maxBytes) throw new TrustStoreError('record-too-large', `${type} exceeds ${maxBytes} bytes`);
  if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    throw new TrustStoreError('record-corrupt', `${type} has a UTF-8 BOM`);
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw);
  } catch {
    throw new TrustStoreError('record-corrupt', `${type} is not valid UTF-8`);
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new TrustStoreError('record-corrupt', `${type} is not JSON`); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TrustStoreError('record-corrupt', `${type} is not a JSON object`);
  }
  // Canonical-byte equality is the duplicate-key guard: a repeated key makes the
  // raw text strictly longer than the single-key canonical form, so it can never
  // compare equal. It also rejects alternate key order and incidental whitespace.
  if (text !== canonicalize(parsed)) throw new TrustStoreError('record-non-canonical', `${type} is not canonical JSON`);
  applySchema(parsed, schema, type);
  return parsed;
}

// schema: { field: validator, ... }. Every declared field is required and must
// pass; any field on the record not declared in the schema is rejected.
export function applySchema(record, schema, type) {
  for (const [field, validator] of Object.entries(schema)) {
    if (!validator(record[field])) throw new TrustStoreError('record-invalid', `${type}.${field} is invalid`);
  }
  for (const field of Object.keys(record)) {
    if (!(field in schema)) throw new TrustStoreError('record-invalid', `${type} has unexpected field: ${field}`);
  }
}
