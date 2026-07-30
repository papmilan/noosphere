import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertForciblyTerminated } from './helpers/child-crash.js';

// The crash tests only ever observe one platform's shape per run, so the other
// platform's contract is asserted here against both spawnSync results.
const POSIX_KILL = { status: null, signal: 'SIGKILL' };
const WINDOWS_TERMINATE = { status: 1, signal: null };

test('a forcible termination is accepted in its POSIX and Windows shapes', () => {
  assertForciblyTerminated(POSIX_KILL, { platform: 'linux' });
  assertForciblyTerminated(POSIX_KILL, { platform: 'darwin' });
  assertForciblyTerminated(WINDOWS_TERMINATE, { platform: 'win32' });
});

test('an orderly exit, a failed spawn, and a mismatched platform are refused', () => {
  assert.throws(() => assertForciblyTerminated(
    { status: 0, signal: null },
    { platform: 'win32' },
  ), /forcibly terminated/);
  assert.throws(() => assertForciblyTerminated(
    { status: 0, signal: null },
    { platform: 'linux' },
  ), /forcibly terminated/);
  assert.throws(() => assertForciblyTerminated(
    { error: new Error('spawn ENOENT'), status: null, signal: null },
    { platform: 'linux' },
  ), /must run, not fail to spawn/);
  // A POSIX run must not silently accept the Windows shape: a caught SIGTERM
  // that exits 1 is not the uncatchable kill these tests rely on.
  assert.throws(() => assertForciblyTerminated(
    WINDOWS_TERMINATE,
    { platform: 'linux' },
  ), /carries no exit status/);
});
