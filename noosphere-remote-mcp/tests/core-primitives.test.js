import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decodeCursor, encodeCursor } from '../core/cursor.js';
import { toPublicError } from '../core/errors.js';
import { normalizeProjectText } from '../core/normalization.js';
import { canonicalJson, requestHash } from '../core/stable-json.js';

const ownerA = 'issuer:https://id.example|subject:user-a';
const ownerB = 'issuer:https://id.example|subject:user-b';

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

  it('rejects a cursor reused by another owner or query', () => {
    const cursor = encodeCursor({ ownerScope: ownerA, operation: 'list_projects', query: { includeArchived: false }, after: 'prj_b' });
    assert.equal(decodeCursor(cursor, { ownerScope: ownerA, operation: 'list_projects', query: { includeArchived: false } }).after, 'prj_b');
    assert.throws(() => decodeCursor(cursor, { ownerScope: ownerB, operation: 'list_projects', query: { includeArchived: false } }), /invalid-cursor/);
    assert.throws(() => decodeCursor(cursor, { ownerScope: ownerA, operation: 'list_projects', query: { includeArchived: true } }), /invalid-cursor/);
  });

  it('rejects malformed cursors and operation reuse', () => {
    const cursor = encodeCursor({ ownerScope: ownerA, operation: 'list_projects', query: {}, after: null });
    assert.throws(() => decodeCursor('not-a-cursor', { ownerScope: ownerA, operation: 'list_projects', query: {} }), /invalid-cursor/);
    assert.throws(() => decodeCursor(cursor, { ownerScope: ownerA, operation: 'list_checkpoints', query: {} }), /invalid-cursor/);
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
});
