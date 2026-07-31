// Restart pacing for managed watchers.
//
// A watcher that fails during startup exits immediately, so an unpaced manager
// respawns it as fast as its reconcile loop runs. Two real causes produce that
// shape — a registered directory that is not a Git repository, and `git`
// missing from the service PATH — and both crashloop until the registry is
// edited by hand. The failure is per-project and the backoff is generic on
// purpose: it paces every startup failure, not the two that were diagnosed.

export const RESTART_BASE_MS = 5_000;
export const RESTART_MAX_MS = 5 * 60_000;
// A watcher that stayed up this long was working; a later exit starts its
// backoff from scratch rather than inheriting an old failure streak.
export const HEALTHY_RUN_MS = 60_000;

export function nextRestartDelayMs(consecutiveFailures) {
  const exponent = Math.max(consecutiveFailures - 1, 0);
  // Cap the exponent before shifting so a long-lived crashloop cannot overflow
  // into Infinity and produce a NaN deadline.
  const scaled = RESTART_BASE_MS * 2 ** Math.min(exponent, 20);
  return Math.min(scaled, RESTART_MAX_MS);
}

// Returns the updated failure record for a watcher that just exited.
// `ranForMs` is how long the child stayed up.
export function recordExit(previous, ranForMs, now = Date.now()) {
  const healthy = ranForMs >= HEALTHY_RUN_MS;
  const consecutiveFailures = healthy ? 1 : (previous?.consecutiveFailures || 0) + 1;
  return {
    consecutiveFailures,
    retryAt: now + nextRestartDelayMs(consecutiveFailures),
  };
}

export function canStart(record, now = Date.now()) {
  return !record || now >= record.retryAt;
}
