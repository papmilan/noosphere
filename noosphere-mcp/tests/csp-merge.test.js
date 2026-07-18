import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mergeState } from '../continuity/csp/merge.js';

function state(overrides = {}) {
  return {
    version: 1,
    status: 'in-progress',
    current_task: 'Implement CSP',
    next_action: 'Run tests',
    blocker: null,
    ...overrides,
  };
}

describe('CSP deterministic three-way merge', () => {
  it('keeps independent one-sided changes', () => {
    const base = state();
    const current = state({ current_task: 'Review CSP' });
    const proposed = state({ next_action: 'Write storage tests' });
    const result = mergeState(base, current, proposed);
    assert.equal(result.ok, true);
    assert.equal(result.state.current_task, 'Review CSP');
    assert.equal(result.state.next_action, 'Write storage tests');
  });

  it('keeps identical changes made by both sides', () => {
    const base = state();
    const current = state({ blocker: 'Waiting for review' });
    const proposed = state({ blocker: 'Waiting for review' });
    const result = mergeState(base, current, proposed);
    assert.equal(result.ok, true);
    assert.equal(result.state.blocker, 'Waiting for review');
  });

  it('returns an explicit scalar conflict and no writable state', () => {
    const result = mergeState(
      state(),
      state({ next_action: 'Publish' }),
      state({ next_action: 'Fix failure' }),
    );
    assert.equal(result.ok, false);
    assert.equal('state' in result, false);
    assert.deepEqual(result.conflicts, [{
      path: '$.next_action',
      base: 'Run tests',
      current: 'Publish',
      proposed: 'Fix failure',
    }]);
  });

  it('recursively merges unknown future object fields without losing keys', () => {
    const base = state({ future: { left: 1, right: 1 } });
    const current = state({ future: { left: 2, right: 1 } });
    const proposed = state({ future: { left: 1, right: 2, added: true } });
    const result = mergeState(base, current, proposed);
    assert.equal(result.ok, true);
    assert.deepEqual(result.state.future, { added: true, left: 2, right: 2 });
  });

  it('treats arrays as atomic values instead of merging positions', () => {
    const result = mergeState(
      state({ future: ['base'] }),
      state({ future: ['current'] }),
      state({ future: ['proposed'] }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.conflicts[0].path, '$.future');
  });

  it('reports delete-versus-change as a conflict', () => {
    const base = state({ future: { retained: 'base' } });
    const current = state({ future: {} });
    const proposed = state({ future: { retained: 'changed' } });
    const result = mergeState(base, current, proposed);
    assert.equal(result.ok, false);
    assert.equal(result.conflicts[0].path, '$.future.retained');
    assert.deepEqual(result.conflicts[0].current, { missing: true });
  });

  it('orders conflicts by JSON path and never mutates inputs', () => {
    const base = state();
    const current = state({ current_task: 'Current task', next_action: 'Current next' });
    const proposed = state({ current_task: 'Proposed task', next_action: 'Proposed next' });
    const before = [base, current, proposed].map((value) => structuredClone(value));
    const first = mergeState(base, current, proposed);
    const second = mergeState(base, current, proposed);
    assert.deepEqual(first, second);
    assert.deepEqual(first.conflicts.map(({ path }) => path), ['$.current_task', '$.next_action']);
    assert.deepEqual([base, current, proposed], before);
  });
});
