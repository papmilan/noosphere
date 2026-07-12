const DEFAULT_TERMINATION_GRACE_MS = 250;
const DEFAULT_FINAL_CLEANUP_TIMEOUT_MS = 250;

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
