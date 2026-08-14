import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
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

// One waiter, in its own process. Configuration arrives through the environment
// rather than argv because `node -e` numbers its arguments differently from a
// script file, and this needs no ambiguity about which slot is which.
const WAITER = `
import { writeFile } from 'node:fs/promises';
import { withOwnerLock } from ${JSON.stringify(new URL('../continuity/acp/owner-lock.js', import.meta.url).href)};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const record = process.env.OWNER_LOCK_RECORD;
await sleep(Number(process.env.OWNER_LOCK_STAGGER_MS));
try {
  await withOwnerLock(process.env.OWNER_LOCK_PATH, { onTimeout: () => new Error('timeout') }, async () => {
    const enter = Date.now();
    await sleep(60);
    await writeFile(record, JSON.stringify({ enter, exit: Date.now() }));
  });
} catch (error) {
  await writeFile(record, JSON.stringify({ failed: error.code ?? error.message }));
}
`;

// A pid nothing occupies: run a process to completion and reuse its number.
// Reuse would make the lock read as live, which fails safe — the test would
// stop reproducing rather than start passing wrongly.
async function deadPid() {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  const pid = child.pid;
  await once(child, 'exit');
  return pid;
}

// Equal timestamps sort exit before enter, so two holders that merely touch at
// a millisecond boundary are not counted as overlapping.
function peakHolders(records) {
  const edges = records
    .flatMap(({ enter, exit }) => [[enter, 1], [exit, -1]])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let inside = 0;
  let peak = 0;
  for (const [, delta] of edges) {
    inside += delta;
    peak = Math.max(peak, inside);
  }
  return peak;
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

  // The test above is blind to the reclaim path: with no lock to start from,
  // nothing is ever judged stale. Seed one whose holder is definitely dead and
  // the waiters race to reclaim it — and a reclaim that rm's the path rather
  // than the lock it judged deletes the live lock a peer just installed.
  //
  // Separate processes, because one event loop moves every waiter through the
  // retry loop in lockstep and the removals all land before any peer has
  // acquired. The OS supplies the interleaving, which is also where this bites:
  // the lock is a cross-process one. Repeated, because it is load-dependent —
  // 16 of 20 trials admitted two holders before this fix, three at the peak.
  it('never admits two holders while a stale lock is being reclaimed', async () => {
    for (let trial = 0; trial < 3; trial += 1) {
      const dir = await temp();
      const lockPath = path.join(dir, 'owner.lock');
      await writeFile(
        lockPath,
        JSON.stringify({ pid: await deadPid(), token: 'dead-holder', created_at: Date.now() }),
        { mode: 0o600 },
      );

      const waiters = 12;
      await Promise.all(Array.from({ length: waiters }, async (_unused, index) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', WAITER], {
          stdio: 'ignore',
          env: {
            ...process.env,
            OWNER_LOCK_PATH: lockPath,
            OWNER_LOCK_RECORD: path.join(dir, `held-${index}.json`),
            OWNER_LOCK_STAGGER_MS: String(index % 8),
          },
        });
        await once(child, 'exit');
      }));

      const held = await Promise.all(Array.from({ length: waiters }, async (_unused, index) =>
        JSON.parse(await readFile(path.join(dir, `held-${index}.json`), 'utf8'))));

      assert.deepEqual(
        held.filter((record) => record.failed).map((record) => record.failed),
        [],
        `trial ${trial}: every waiter must acquire the reclaimed lock`,
      );
      assert.equal(
        peakHolders(held),
        1,
        `trial ${trial}: the lock admitted more than one holder at a time`,
      );
    }
  });

  // Windows reports a held lock as EPERM/EACCES/EBUSY, not EEXIST. Surfacing
  // those raw is what made acp-sync-metadata read as flaky: a concurrent issuer
  // got a filesystem error instead of waiting its turn, so the suite counted
  // one confirmation-limit rejection too few.
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    it(`treats a Windows ${code} as contention rather than a fault`, async () => {
      const lockPath = path.join(await temp(), 'owner.lock');
      let attempts = 0;
      const openImpl = async (...args) => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error(`${code}: busy`), { code });
        return open(...args);
      };

      const held = await withOwnerLock(
        lockPath,
        { onTimeout, platform: 'win32', openImpl },
        async () => 'acquired',
      );

      assert.equal(held, 'acquired', 'the waiter must retry rather than surface the error');
      assert.equal(attempts, 2);
      assert.equal(existsSync(lockPath), false, 'the lock must be released');
    });

    it(`still surfaces ${code} as a fault away from Windows`, async () => {
      const lockPath = path.join(await temp(), 'owner.lock');
      const openImpl = async () => {
        throw Object.assign(new Error(`${code}: denied`), { code });
      };

      await assert.rejects(
        withOwnerLock(lockPath, { onTimeout, platform: 'linux', openImpl }, async () => 'unreachable'),
        (error) => error.code === code,
      );
    });
  }

  // A disk that fills between the exclusive create and the write leaves the
  // acquisition half-done. The descriptor must not escape with it, and neither
  // must the empty lock file: an abandoned lock is one nobody can clear until
  // the orphan sweep, a minute later.
  it('closes the handle and removes the lock when the lock write fails', async () => {
    const lockPath = path.join(await temp(), 'owner.lock');
    const probe = await open(path.join(await temp(), 'probe'), 'w');
    const fileHandle = Object.getPrototypeOf(probe);
    await probe.close();

    const realWriteFile = fileHandle.writeFile;
    let leaked;
    fileHandle.writeFile = async function failingWriteFile(...args) {
      if (this.fd === undefined) return realWriteFile.apply(this, args);
      leaked = this;
      fileHandle.writeFile = realWriteFile;
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    };

    try {
      await assert.rejects(
        withOwnerLock(lockPath, { onTimeout }, async () => 'unreachable'),
        (error) => error.code === 'ENOSPC',
      );
    } finally {
      fileHandle.writeFile = realWriteFile;
    }

    assert.equal(leaked.fd, -1, 'the lock descriptor was left open');
    assert.equal(existsSync(lockPath), false, 'the abandoned lock file was left behind');
  });
});
