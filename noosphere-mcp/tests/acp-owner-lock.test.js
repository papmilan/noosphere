import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { withOwnerLock } from '../continuity/acp/owner-lock.js';

const dirs = [];
after(async () => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

async function temp() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'noosphere-owner-lock-'));
  dirs.push(root);
  return root;
}

const onTimeout = () => Object.assign(new Error('lock-timeout'), { code: 'lock-timeout' });

describe('ACP owner lock', () => {
  // The waiter's budget used to be 500 retries of a fixed 10ms sleep — about
  // five seconds, no matter how long the holder actually needed. A holder that
  // outlives that budget is precisely the Windows case that made
  // acp-sync-metadata flaky: waiters timed out on a lock that was held and
  // progressing, not stuck. This hold sits past the old budget and well inside
  // the new one, so it fails on the old code and passes on the new.
  const HOLD_MS = 6_500;

  it('waits out a live holder that runs longer than the old retry budget', async () => {
    const lockPath = path.join(await temp(), 'owner.lock');
    let releasedAt = 0;

    const holder = withOwnerLock(lockPath, { onTimeout }, async () => {
      await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
      releasedAt = Date.now();
      return 'holder';
    });
    // Let the holder take the lock before the waiter starts contending.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const waiter = withOwnerLock(lockPath, { onTimeout }, async () => Date.now());

    const [held, acquiredAt] = await Promise.all([holder, waiter]);
    assert.equal(held, 'holder');
    assert.ok(
      acquiredAt >= releasedAt,
      `waiter acquired at ${acquiredAt}, before the holder released at ${releasedAt}`,
    );
  });

  it('serializes contending waiters instead of interleaving them', async () => {
    const lockPath = path.join(await temp(), 'owner.lock');
    let inside = 0;
    let maxInside = 0;

    await Promise.all(Array.from({ length: 12 }, () => withOwnerLock(lockPath, { onTimeout }, async () => {
      inside += 1;
      maxInside = Math.max(maxInside, inside);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inside -= 1;
    })));

    assert.equal(maxInside, 1);
  });
});
