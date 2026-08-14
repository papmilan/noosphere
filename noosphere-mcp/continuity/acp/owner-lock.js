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

export async function staleLock(lockPath, requireToken) {
  const lock = await readLockJson(lockPath);
  if (!lock || !Number.isInteger(lock.pid) || (requireToken && typeof lock.token !== 'string')) {
    const details = await lstat(lockPath).catch(() => null);
    return details !== null && Date.now() - details.mtimeMs > ORPHAN_LOCK_MS;
  }
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
// The removal has to be conditional on the lock still being the one that was
// judged, and no filesystem call offers that: unlink names a path, never an
// inode, and link() — which would at least be atomic — is ENOTSUP on SMB and
// most network mounts (csp/storage.js says so at its own rename fallback).
// Exclusive create is the one atomic primitive available everywhere this ships,
// so the reclaim is serialized behind a second one and staleness is re-judged
// INSIDE it. Reclaimers can no longer invalidate each other's judgement, and an
// ordinary acquirer removes nothing — it only creates where nothing exists.
//
// Returns whether the stale lock was actually removed, so a caller that
// reclaimed nothing still backs off instead of spinning.
export async function reclaimStaleLock(lockPath, requireToken) {
  // The guard carries no contents: it exists or it does not. Nothing reads it,
  // so there is no half-written state to reason about — only the create, which
  // is atomic, and the mtime, which is what ages an orphan out. Deliberately
  // not `openImpl`: that seam stands for the lock's own Windows contention
  // path, and the guard's failure handling is code-agnostic anyway.
  const guardPath = `${lockPath}.reclaim`;
  let guard;
  try {
    guard = await open(guardPath, 'wx', 0o600);
  } catch {
    // Another waiter is reclaiming, or one was killed mid-reclaim. Both are
    // handled by waiting: the caller's deadline still governs.
    await dropOrphanedGuard(guardPath);
    return false;
  }
  try {
    // Re-judged under exclusion. By now the lock may be gone, or may be the
    // live lock of whoever reclaimed it first — in which case, hands off.
    if (!(await staleLock(lockPath, requireToken))) return false;
    await rm(lockPath, { force: true });
    return true;
  } finally {
    await guard.close().catch(() => {});
    await rm(guardPath, { force: true }).catch(() => {});
  }
}

// A guard only outlives its reclaim if the process holding it was killed
// outright during the few syscalls one takes. Ageing it out costs an extra
// ORPHAN_LOCK_MS before reclaim resumes; leaving it would wedge the lock for
// good. This rm races exactly as the one it replaced did — but its worst case
// is two concurrent reclaimers, which is the behaviour before this change, and
// reaching it needs a SIGKILL inside that window AND a guard sitting exactly at
// the age bound.
async function dropOrphanedGuard(guardPath) {
  const details = await lstat(guardPath).catch(() => null);
  if (details !== null && Date.now() - details.mtimeMs > ORPHAN_LOCK_MS) {
    await rm(guardPath, { force: true }).catch(() => {});
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
