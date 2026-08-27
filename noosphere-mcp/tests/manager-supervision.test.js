import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import {
  createCoalescedRunner,
  superviseChild,
} from '../lifecycle/manager-supervision.js';

describe('manager background-work supervision', () => {
  it('never overlaps reconciliation and coalesces ticks that arrive while it is running', async () => {
    let releaseFirst;
    const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
    let startedFirst;
    const firstStarted = new Promise((resolve) => { startedFirst = resolve; });
    let runs = 0;
    let active = 0;
    let maximumActive = 0;
    const runner = createCoalescedRunner(async () => {
      runs += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (runs === 1) {
        startedFirst();
        await firstBlocked;
      }
      active -= 1;
    });

    const first = runner.run();
    await firstStarted;
    const second = runner.run();
    const third = runner.run();
    releaseFirst();
    await Promise.all([first, second, third]);

    assert.equal(maximumActive, 1);
    assert.equal(runs, 2, 'many overlapping timer ticks become one follow-up pass');
  });

  it('reports a failed pass without poisoning later reconciliation', async () => {
    const errors = [];
    let runs = 0;
    const runner = createCoalescedRunner(async () => {
      runs += 1;
      if (runs === 1) throw new Error('transient registry read');
    }, { onError: (error) => errors.push(error.message) });

    await runner.run();
    await runner.run();
    assert.deepEqual(errors, ['transient registry read']);
    assert.equal(runs, 2);
  });

  it('handles a child spawn error once even if a later exit event also arrives', () => {
    const child = new EventEmitter();
    const outcomes = [];
    superviseChild(child, (outcome) => outcomes.push(outcome));

    const failure = Object.assign(new Error('cwd disappeared'), { code: 'ENOENT' });
    child.emit('error', failure);
    child.emit('exit', 1, null);

    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].error, failure);
    assert.equal(outcomes[0].code, null);
  });
});
