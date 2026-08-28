import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decodeCursor, encodeCursor } from '../core/cursor.js';
import { toPublicError } from '../core/errors.js';
import { normalizeProjectText } from '../core/normalization.js';
import { canonicalJson, requestHash } from '../core/stable-json.js';

const ownerA = 'issuer:https://id.example|subject:user-a';
const ownerB = 'issuer:https://id.example|subject:user-b';
const cursorSecret = 'cursor-secret-used-only-by-project-memory';

describe('Project Memory core primitives', () => {
  it('uses NFKC, trim, whitespace collapse, and lowercase', () => {
    assert.equal(normalizeProjectText('  Ｂicycle\tRepair  '), 'bicycle repair');
  });

  it('canonicalizes object keys recursively while preserving array order', () => {
    assert.equal(
      canonicalJson({ z: [{ b: 2, a: 1 }, 'second'], a: { y: true, x: null } }),
      '{"a":{"x":null,"y":true},"z":[{"a":1,"b":2},"second"]}',
    );
  });

  it('creates the same request hash for semantically equivalent object key order', () => {
    assert.equal(
      requestHash({ project: { name: 'Bicycle Repair', aliases: ['bike', 'repair'] }, operation: 'create_project' }),
      requestHash({ operation: 'create_project', project: { aliases: ['bike', 'repair'], name: 'Bicycle Repair' } }),
    );
  });

  it('keeps array order in request hashes', () => {
    assert.notEqual(requestHash({ aliases: ['bike', 'repair'] }), requestHash({ aliases: ['repair', 'bike'] }));
  });

  it('rejects sparse arrays instead of hashing them like a different JSON value', () => {
    const sparse = [];
    sparse.length = 1;

    assert.throws(() => canonicalJson(sparse), /invalid-canonical-json/);
    assert.throws(() => requestHash({ values: sparse }), /invalid-canonical-json/);
  });

  it('rejects values whose own properties are not their whole content', () => {
    // Dates, Maps, Sets, and class instances carry state that Object.keys cannot
    // see. Canonicalizing them by their own enumerable properties would hash two
    // distinct values to one string — every Date to `{}` — which at a request-hash
    // trust boundary means one request's result answering a different request.
    class Marker {
      constructor(value) {
        this.value = value;
      }
    }

    for (const [label, left, right] of [
      ['Date', new Date(0), new Date(999)],
      ['Map', new Map([['a', 1]]), new Map([['b', 2]])],
      ['Set', new Set([1]), new Set([2])],
      ['class instance', new Marker(1), new Marker(2)],
    ]) {
      assert.throws(() => canonicalJson(left), /invalid-canonical-json/, `${label} was canonicalized`);
      assert.throws(() => requestHash({ value: right }), /invalid-canonical-json/, `${label} was hashed`);
    }

    // A null-prototype object is still exactly its own properties, so it stays
    // canonicalizable and must agree with the plain-object form.
    assert.equal(canonicalJson(Object.assign(Object.create(null), { b: 2, a: 1 })), '{"a":1,"b":2}');
  });

  it('rejects cycles but permits the same acyclic value to appear twice', () => {
    const cycle = {};
    cycle.self = cycle;
    const shared = { answer: 42 };

    assert.throws(() => canonicalJson(cycle), /invalid-canonical-json/);
    assert.equal(
      canonicalJson({ left: shared, right: shared }),
      '{"left":{"answer":42},"right":{"answer":42}}',
    );
  });

  it('canonicalizes very deep JSON without overflowing the JavaScript stack', () => {
    let value = null;
    for (let index = 0; index < 20_000; index += 1) value = { child: value };

    const encoded = canonicalJson(value);

    assert.equal(encoded.startsWith('{"child":{"child":'), true);
    assert.equal(encoded.endsWith('}'.repeat(20_000)), true);
  });

  it('encrypts cursor state and does not expose its owner binding', () => {
    const cursor = encodeCursor({ ownerScope: ownerA, operation: 'list_projects', query: { includeArchived: false }, after: 'prj_b' }, cursorSecret);
    assert.match(cursor, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
    assert.equal(cursor.includes(ownerA), false);
    assert.equal(cursor.includes('prj_b'), false);
    assert.equal(
      decodeCursor(cursor, { ownerScope: ownerA, operation: 'list_projects', query: { includeArchived: false } }, cursorSecret).after,
      'prj_b',
    );
  });

  it('accepts a cursor for textually equivalent normalized query filters', () => {
    const cursor = encodeCursor({
      ownerScope: ownerA,
      operation: 'list_projects',
      query: { search: '  Ｂicycle\tRepair  ', filters: ['  ACTIVE ', { label: ' Café\nShop ' }], includeArchived: false },
      after: 'prj_b',
    }, cursorSecret);
    assert.equal(
      decodeCursor(cursor, {
        ownerScope: ownerA,
        operation: 'list_projects',
        query: { includeArchived: false, search: 'bicycle repair', filters: ['active', { label: 'café shop' }] },
      }, cursorSecret).after,
      'prj_b',
    );
  });

  it('binds a deeply nested cursor query without recursive stack failure', () => {
    let query = '  Café\tRepair  ';
    for (let index = 0; index < 20_000; index += 1) query = { child: query };

    const cursor = encodeCursor({
      ownerScope: ownerA,
      operation: 'list_projects',
      query,
      after: 'prj_b',
    }, cursorSecret);

    assert.equal(
      decodeCursor(cursor, { ownerScope: ownerA, operation: 'list_projects', query }, cursorSecret).after,
      'prj_b',
    );
  });

  it('rejects cursor tampering and binding changes', () => {
    const cursor = encodeCursor({ ownerScope: ownerA, operation: 'list_projects', query: { after: 'filter-a', includeArchived: false }, after: 'prj_b' }, cursorSecret);
    const [version, iv, ciphertext, tag] = cursor.split('.');
    const binding = { ownerScope: ownerA, operation: 'list_projects', query: { after: 'filter-a', includeArchived: false } };

    assert.throws(() => decodeCursor(cursor, binding, 'another-injected-cursor-secret'), /invalid-cursor/);
    assert.throws(() => decodeCursor(cursor, { ...binding, ownerScope: ownerB }, cursorSecret), /invalid-cursor/);
    assert.throws(() => decodeCursor(cursor, { ...binding, operation: 'list_checkpoints' }, cursorSecret), /invalid-cursor/);
    assert.throws(() => decodeCursor(cursor, { ...binding, query: { after: 'filter-b', includeArchived: false } }, cursorSecret), /invalid-cursor/);
    assert.throws(() => decodeCursor(`${version}.${iv}.${flipBase64urlCharacter(ciphertext)}.${tag}`, binding, cursorSecret), /invalid-cursor/);
    assert.throws(() => decodeCursor(`${version}.${iv}.${ciphertext}.${flipBase64urlCharacter(tag)}`, binding, cursorSecret), /invalid-cursor/);
  });

  it('rejects malformed cursors and operation reuse', () => {
    const cursor = encodeCursor({ ownerScope: ownerA, operation: 'list_projects', query: {}, after: null }, cursorSecret);
    assert.throws(() => encodeCursor({ ownerScope: ownerA, operation: 'list_projects', query: {}, after: null }), /invalid-cursor/);
    assert.throws(() => decodeCursor('not-a-cursor', { ownerScope: ownerA, operation: 'list_projects', query: {} }, cursorSecret), /invalid-cursor/);
    assert.throws(() => decodeCursor(cursor, { ownerScope: ownerA, operation: 'list_checkpoints', query: {} }, cursorSecret), /invalid-cursor/);
    assert.throws(() => decodeCursor(cursor, { ownerScope: ownerA, operation: 'list_projects', query: {} }), /invalid-cursor/);
  });

  it('preserves existing structured public errors without internal details', () => {
    const publicError = { isError: true, error: { code: 'not-found', retryable: false } };
    assert.deepEqual(toPublicError(publicError), publicError);
  });

  it('redacts unknown internal errors to a generic public envelope', () => {
    assert.deepEqual(toPublicError(new Error('database password leaked')), {
      isError: true,
      error: { code: 'internal', retryable: false },
    });
  });

  it('redacts hostile error-envelope inspection failures without throwing', () => {
    const hostileError = new Proxy({}, {
      get() {
        throw new Error('hostile getter');
      },
    });

    assert.deepEqual(toPublicError(hostileError), {
      isError: true,
      error: { code: 'internal', retryable: false },
    });
  });
});

function flipBase64urlCharacter(value) {
  return `${value[0] === 'A' ? 'B' : 'A'}${value.slice(1)}`;
}
