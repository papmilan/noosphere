import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  HEALTHY_RUN_MS,
  RESTART_BASE_MS,
  RESTART_MAX_MS,
  canStart,
  nextRestartDelayMs,
  recordExit,
} from '../lifecycle/restart-policy.js';

describe('watcher restart policy', () => {
  it('backs off exponentially and stops at the cap', () => {
    assert.equal(nextRestartDelayMs(1), RESTART_BASE_MS);
    assert.equal(nextRestartDelayMs(2), RESTART_BASE_MS * 2);
    assert.equal(nextRestartDelayMs(3), RESTART_BASE_MS * 4);
    assert.equal(nextRestartDelayMs(100), RESTART_MAX_MS);
    // A very long crashloop must not overflow into NaN/Infinity.
    assert.equal(Number.isFinite(nextRestartDelayMs(5000)), true);
    assert.equal(nextRestartDelayMs(5000), RESTART_MAX_MS);
  });

  it('paces a crashloop instead of respawning every reconcile tick', () => {
    // The real shape: a watcher that exits immediately, over and over. Before
    // the backoff this respawned every 5s reconcile forever — 93133 restarts
    // were observed in one manager log.
    const reconcileEveryMs = 5_000;
    let now = 0;
    let record;
    let starts = 0;

    for (let tick = 0; tick < 720; tick += 1) {
      // one hour of reconcile ticks
      if (canStart(record, now)) {
        starts += 1;
        record = recordExit(record, 0, now); // exits instantly
      }
      now += reconcileEveryMs;
    }

    assert.equal(starts < 20, true, `expected backoff to pace restarts, got ${starts}`);
    // Unpaced this would be one start per tick.
    assert.equal(starts < 720 / 10, true);
  });

  it('resets the streak after a watcher that stayed up', () => {
    const failed = recordExit(recordExit(undefined, 0, 0), 0, 0);
    assert.equal(failed.consecutiveFailures, 2);

    const afterHealthy = recordExit(failed, HEALTHY_RUN_MS, 0);
    assert.equal(afterHealthy.consecutiveFailures, 1);
    assert.equal(afterHealthy.retryAt, RESTART_BASE_MS);
  });

  it('allows a first start and blocks only until the deadline', () => {
    assert.equal(canStart(undefined, 0), true);
    const record = recordExit(undefined, 0, 0);
    assert.equal(canStart(record, record.retryAt - 1), false);
    assert.equal(canStart(record, record.retryAt), true);
  });
});
