import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { is, parseAuthenticatedRecord } from '../continuity/internal/strict-schema.js';

const schema = { type: is.enumOf(new Set(['x'])), n: is.posInt, at: is.rfc3339utc, id: is.uuid, h: is.hex64 };
const good = { type: 'x', n: 1, at: '2026-07-24T12:00:00Z', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', h: 'a'.repeat(64) };
function bytes(obj) { return Buffer.from(canonical(obj), 'utf8'); }
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}
const parse = (raw) => parseAuthenticatedRecord(raw, { type: 'x', maxBytes: 4096, schema });

describe('SEC-05 Phase 4A-R1 — strict schema parser', () => {
  it('accepts an exact canonical record', () => {
    assert.deepEqual(parse(bytes(good)), good);
  });

  it('rejects an over-cap payload before decode', () => {
    assert.throws(() => parseAuthenticatedRecord(Buffer.alloc(4097, 0x20), { type: 'x', maxBytes: 4096, schema }), (e) => e.code === 'record-too-large');
  });

  it('rejects a UTF-8 BOM', () => {
    assert.throws(() => parse(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes(good)])), (e) => e.code === 'record-corrupt');
  });

  it('rejects invalid UTF-8 (fatal decode)', () => {
    assert.throws(() => parse(Buffer.from([0x7b, 0xff, 0x7d])), (e) => e.code === 'record-corrupt');
  });

  it('rejects non-canonical key order', () => {
    assert.throws(() => parse(Buffer.from('{"n":1,"type":"x","at":"2026-07-24T12:00:00Z","id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","h":"' + 'a'.repeat(64) + '"}', 'utf8')), (e) => e.code === 'record-non-canonical');
  });

  it('rejects a duplicate key via the canonical compare', () => {
    assert.throws(() => parse(Buffer.from('{"at":"2026-07-24T12:00:00Z","at":"2026-07-24T12:00:00Z","h":"' + 'a'.repeat(64) + '","id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","n":1,"type":"x"}', 'utf8')), (e) => e.code === 'record-non-canonical');
  });

  it('rejects an unknown field', () => {
    assert.throws(() => parse(bytes({ ...good, extra: 1 })), (e) => e.code === 'record-invalid');
  });

  it('rejects a non-UTC / malformed timestamp', () => {
    for (const at of ['2026-07-24T12:00:00+02:00', '2026-13-40T12:00:00Z', '2026-07-24 12:00:00Z', 'not-a-date']) {
      assert.throws(() => parse(bytes({ ...good, at })), (e) => e.code === 'record-invalid');
    }
  });

  it('rejects an out-of-enum type and a non-integer count', () => {
    assert.throws(() => parse(bytes({ ...good, type: 'y' })), (e) => e.code === 'record-invalid');
    assert.throws(() => parse(bytes({ ...good, n: 1.5 })), (e) => e.code === 'record-invalid');
    assert.throws(() => parse(bytes({ ...good, n: 0 })), (e) => e.code === 'record-invalid');
  });
});
