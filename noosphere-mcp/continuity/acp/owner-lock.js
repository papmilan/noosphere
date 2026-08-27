import { randomUUID } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import { readBoundedRegularFile, tryAcquireOwnerProcessGuard } from '../secure-fs.js';

// SEC-05 Phase 4B-R4 — bounded, non-blocking lock read.
//
// A lock path lives inside the working tree, so anything that can write there
// can plant a FIFO at it. A bare readFile then blocks forever with no error
// code, which strands the release and stale-check paths this helper serves.
// Locks are small JSON; the shared primitive refuses anything non-regular,
// symlinked, or larger, and never blocks on the open.
const MAX_LOCK_BYTES = 4096;

// Waiting is bounded by wall clock rather than by a retry count. A count means
// a different timeout on every filesystem: the 500 attempts this replaced spent
// about five seconds where a failed open is cheap, but the work being waited on
// grows with the filesystem too, and faster. On Windows, where owner-only
// writes shell out to icacls, twenty contenders serialized past that budget and
// the last one timed out waiting for a lock nobody held for long.
const LOCK_TIMEOUT_MS = 30_000;

// Full jitter. A fixed sleep wakes every waiter in lockstep, so the same loser
// can be beaten to the open() over and over; spreading retries drains the queue
// fairly instead of starving whoever is unlucky.
const LOCK_RETRY_CAP_MS = 25;

export async function readLockJson(lockPath) {
  try {
    const raw = await readBoundedRegularFile(lockPath, { maxBytes: MAX_LOCK_BYTES });
    return raw === null ? null : JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
}

export async function staleLock(lockPath, requireToken) {
  const lock = await readLockJson(lockPath);
  // Malformed, unsafe, or unreadable metadata is never reclaimed on age alone:
  // a delayed live initializer is observationally identical to an abandoned
  // partial write. Only an explicit dead PID is safe to remove automatically.
  if (!lock || !Number.isInteger(lock.pid) || lock.pid <= 0
    || (requireToken && typeof lock.token !== 'string')) return false;
  try { process.kill(lock.pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

// Reclaiming a lock judged stale cannot be a bare `rm` of the path. Between the
// judgement and the removal, another waiter can reclaim the same stale lock and
// install its own LIVE lock there — and the rm then deletes THAT, leaving two
// holders, each believing it is alone. Measured across separate processes with
// a dead holder seeded: 16 of 20 trials ran two operations at once, three at the
// peak.
//
// Reclaim is serialized behind a process-owned directory guard and staleness is
// re-judged inside it. The guard prepares its exact owner marker before the
// directory is atomically installed, safely recovers a dead reclaimer, and can
// never delete a successor because removal targets the old marker before an
// empty-directory rmdir.
//
// Returns whether the stale lock was actually removed, so a caller that
// reclaimed nothing still backs off instead of spinning.
export async function reclaimStaleLock(lockPath, requireToken) {
  const guard = await tryAcquireOwnerProcessGuard(`${lockPath}.reclaim`);
  if (guard === null) return false;
  try {
    // Re-judged under exclusion. By now the lock may be gone, or may be the
    // live lock of whoever reclaimed it first — in which case, hands off.
    if (!(await staleLock(lockPath, requireToken))) return false;
    await rm(lockPath, { force: true });
    return true;
  } finally {
    await guard.release().catch(() => {});
  }
}

// Runs `operation` while holding an exclusive owner-only lock file. The caller
// owns the containing directory and its mode; this owns only the lock itself.
// `onTimeout` builds the caller's own error so each subsystem keeps its
// existing error code.
// POSIX answers an exclusive create against an existing lock with EEXIST.
// Windows answers with EPERM, EACCES or EBUSY whenever another handle still
// holds the file — including one already unlinked but pending delete, which is
// exactly the state this module's own release leaves behind for a moment.
//
// Classifying those as fatal turned ordinary contention into a hard failure:
// with twenty concurrent issuers on Windows CI, a loser surfaced a raw EPERM
// instead of either acquiring the lock or timing out with the caller's own
// error, so `acp-sync-metadata` counted one rejection too few and read as a
// flaky test. csp/storage.js has classified them this way since the CSP lock
// hit the same thing; this module was written without it.
function isLockContention(error, platform) {
  if (error.code === 'EEXIST') return true;
  return platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(error.code);
}

export async function withOwnerLock(lockPath, {
  onTimeout,
  requireToken = false,
  // Injectable so the Windows contention path is exercisable off Windows,
  // matching csp/storage.js and NOOSPHERE_TEST_PLATFORM elsewhere.
  platform = process.platform,
  openImpl = open,
}, operation) {
  const token = randomUUID();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let handle;
  while (!handle) {
    // The lock is held only once its contents land. A failure after the
    // exclusive create — ENOSPC, EIO — used to leave the loop with the
    // descriptor still open and the empty lock file still on disk: the process
    // leaked a handle, and every other waiter exhausted its deadline on a lock
    // nobody held. Publish `handle` only after the write, and hand back what we
    // created if it does not.
    let opened;
    try {
      opened = await openImpl(lockPath, 'wx', 0o600);
      await opened.writeFile(JSON.stringify({ pid: process.pid, token, created_at: Date.now() }));
      await opened.sync();
      handle = opened;
    } catch (error) {
      if (opened) {
        await opened.close().catch(() => {});
        await rm(lockPath, { force: true }).catch(() => {});
      }
      if (!isLockContention(error, platform)) throw error;
      if (Date.now() >= deadline) throw onTimeout();
      // The outer check is a filter, not the decision: it keeps ordinary
      // contention from creating and removing a guard file on every retry. The
      // judgement that the removal acts on is the one inside the guard.
      let reclaimed = false;
      if (await staleLock(lockPath, requireToken)) {
        reclaimed = await reclaimStaleLock(lockPath, requireToken);
      }
      // Backing off unless something actually changed, so losing the reclaim to
      // a peer costs a jittered sleep rather than a spin on open().
      if (!reclaimed) await new Promise((resolve) => setTimeout(resolve, Math.random() * LOCK_RETRY_CAP_MS));
    }
  }
  try { return await operation(); } finally {
    // A close that fails must not strand the lock file behind it.
    await handle.close().catch(() => {});
    const current = await readLockJson(lockPath);
    if (current?.token === token) await rm(lockPath, { force: true });
  }
}
