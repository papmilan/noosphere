import { randomUUID } from 'node:crypto';
import { lstat, open, rm } from 'node:fs/promises';
import { readBoundedRegularFile } from '../secure-fs.js';

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

// A lock whose contents are unreadable is only reclaimed once it is old enough
// that no live writer could still be mid-write.
const ORPHAN_LOCK_MS = 60_000;

export async function readLockJson(lockPath) {
  try {
    const raw = await readBoundedRegularFile(lockPath, { maxBytes: MAX_LOCK_BYTES });
    return raw === null ? null : JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
}

async function staleLock(lockPath, requireToken) {
  const lock = await readLockJson(lockPath);
  if (!lock || !Number.isInteger(lock.pid) || (requireToken && typeof lock.token !== 'string')) {
    const details = await lstat(lockPath).catch(() => null);
    return details !== null && Date.now() - details.mtimeMs > ORPHAN_LOCK_MS;
  }
  try { process.kill(lock.pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
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
    // leaked a handle, and every other waiter sat out ORPHAN_LOCK_MS for a lock
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
      if (await staleLock(lockPath, requireToken)) await rm(lockPath, { force: true });
      else await new Promise((resolve) => setTimeout(resolve, Math.random() * LOCK_RETRY_CAP_MS));
    }
  }
  try { return await operation(); } finally {
    // A close that fails must not strand the lock file behind it.
    await handle.close().catch(() => {});
    const current = await readLockJson(lockPath);
    if (current?.token === token) await rm(lockPath, { force: true });
  }
}
