const DEFAULT_TERMINATION_GRACE_MS = 250;
const DEFAULT_FINAL_CLEANUP_TIMEOUT_MS = 250;

// A wall-clock budget is not portable, so one literal is either flaky on the
// slowest platform or slow to report a real hang on the fastest. A `noosphere`
// CLI spawn costs 0.5-3.4s on a Windows CI runner against a fraction of that
// locally, and a shared runner's tail is far worse than its median: an 8s cap
// with roughly 5x headroom still expired once on a test whose successful runs
// finish in 1.7s end to end. Scale with the platform instead of raising the
// number for everyone — a longer budget costs nothing while tests pass, since
// it only bounds how quickly a genuine hang is reported.
const SLOW_PLATFORM_SCALE = 4;

export function testBudgetMs(baseMs, { platform = process.platform, env = process.env } = {}) {
  // NOOSPHERE_TEST_TIMEOUT_SCALE also shrinks budgets, which is how a
  // give-up path is provable locally without waiting out the real one.
  const configured = Number(env.NOOSPHERE_TEST_TIMEOUT_SCALE);
  const scale = Number.isFinite(configured) && configured > 0
    ? configured
    : (platform === 'win32' ? SLOW_PLATFORM_SCALE : 1);
  return Math.round(baseMs * scale);
}

export function waitForChild(
  child,
  args,
  {
    timeoutMs,
    command = 'noosphere',
    terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
    finalCleanupTimeoutMs = DEFAULT_FINAL_CLEANUP_TIMEOUT_MS,
  },
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timeoutError = new Error(
      `Timed out after ${timeoutMs}ms running ${command} ${args.join(' ')}`,
    );
    const timer = setTimeout(() => {
      timedOut = true;
      terminateChild(child, terminationGraceMs, finalCleanupTimeoutMs).then(
        () => settle(reject, timeoutError),
        (error) => settle(reject, error),
      );
    }, timeoutMs);

    child.once('close', (code) => {
      settle(timedOut ? reject : resolve, timedOut ? timeoutError : code);
    });
    child.once('error', (error) => settle(reject, error));
  });
}

function terminateChild(
  child,
  terminationGraceMs,
  finalCleanupTimeoutMs,
) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let killTimer;
    let finalCleanupTimer;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(killTimer);
      clearTimeout(finalCleanupTimer);
      resolve();
    };
    child.once('close', finish);
    child.once('error', (error) => {
      clearTimeout(killTimer);
      clearTimeout(finalCleanupTimer);
      reject(error);
    });
    child.kill('SIGTERM');
    if (finished) return;
    killTimer = setTimeout(() => child.kill('SIGKILL'), terminationGraceMs);
    finalCleanupTimer = setTimeout(
      finish,
      terminationGraceMs + finalCleanupTimeoutMs,
    );
  });
}
