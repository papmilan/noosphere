import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { validateState } from '../continuity/csp/validate.js';

function validState(overrides = {}) {
  return {
    version: 1,
    status: 'in-progress',
    current_task: 'Implement CSP v1',
    next_action: 'Run tests',
    blocker: null,
    ...overrides,
  };
}

describe('CSP v1 validation', () => {
  it('accepts and deep-freezes the exact v1 shape', () => {
    const result = validateState(validState());
    assert.equal(result.ok, true);
    assert.equal(Object.isFrozen(result.state), true);
  });

  it('rejects every runtime or unknown field from the tracked document', () => {
    for (const field of ['agent', 'branch', 'head', 'revision', 'last_update', 'unexpected']) {
      const result = validateState(validState({ [field]: 'runtime-only' }));
      assert.deepEqual(result.errors.map(({ path, code }) => ({ path, code })), [
        { path: `$.${field}`, code: 'unknown-field' },
      ]);
    }
  });

  it('rejects missing fields, unsupported versions, and invalid statuses', () => {
    const missing = validState();
    delete missing.next_action;
    assert.equal(validateState(missing).errors[0].code, 'required');
    assert.equal(validateState(validState({ version: 2 })).errors[0].code, 'unsupported-version');
    assert.equal(validateState(validState({ status: 'paused' })).errors[0].code, 'enum');
  });

  it('requires blocked state to carry a blocker', () => {
    const result = validateState(validState({ status: 'blocked', blocker: null }));
    assert.equal(result.ok, false);
    assert.equal(result.errors.at(-1).code, 'blocked-without-blocker');
  });

  it('enforces bounded non-empty durable strings', () => {
    assert.equal(validateState(validState({ current_task: null, next_action: null })).ok, true);
    assert.equal(validateState(validState({ current_task: '' })).ok, false);
    assert.equal(validateState(validState({ next_action: 'x'.repeat(1001) })).ok, false);
  });

  it('measures schema string limits in Unicode code points', () => {
    assert.equal(validateState(validState({ current_task: '😀'.repeat(1000) })).ok, true);
    assert.equal(validateState(validState({ current_task: '😀'.repeat(1001) })).ok, false);
  });

  it('rejects non-NFC and control characters in every string', () => {
    assert.equal(validateState(validState({ current_task: 'e\u0301' })).errors[0].code, 'not-nfc');
    assert.equal(validateState(validState({ next_action: 'run\ntests' })).errors[0].code, 'control-character');
  });

  it('ships a schema whose required fields and closed objects match runtime validation', async () => {
    const schema = JSON.parse(await readFile(new URL('../continuity/csp/schema.json', import.meta.url), 'utf8'));
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required.sort(), Object.keys(validState()).sort());
    assert.deepEqual(Object.keys(schema.properties).sort(), Object.keys(validState()).sort());
    assert.deepEqual(schema.properties.status.enum, [
      'not-started', 'in-progress', 'blocked', 'done', 'archived',
    ]);
  });
});

export { validState };
