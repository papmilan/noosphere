import assert from 'node:assert/strict';

// The crash children terminate themselves with `process.kill(pid, 'SIGKILL')`.
// POSIX delivers that as an uncatchable signal, so the parent observes
// `status === null` and `signal === 'SIGKILL'`. Windows has no signals: Node
// maps SIGKILL onto TerminateProcess, so the same abrupt death surfaces as a
// non-zero exit status with `signal === null`. Both are forcible terminations
// that run no shutdown handler, which is the property these tests need;
// asserting the POSIX shape alone fails every crash test on windows-latest.
export function assertForciblyTerminated(child, options = {}) {
  const platform = options.platform ?? process.platform;
  const detail = `signal=${child.signal}, status=${child.status}`;
  const context = options.context ? `${options.context}\n` : '';
  assert.equal(child.error, undefined,
    `${context}child must run, not fail to spawn (${detail}): ${child.error?.message}`);
  assert.ok(
    child.signal === 'SIGKILL' || (child.signal === null && child.status !== 0),
    `${context}child must be forcibly terminated (${detail})`,
  );
  if (platform !== 'win32') {
    assert.equal(child.status, null,
      `${context}a POSIX crash carries no exit status (${detail})`);
    assert.equal(child.signal, 'SIGKILL',
      `${context}a POSIX crash is an uncatchable SIGKILL (${detail})`);
  }
}
