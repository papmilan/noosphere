// Test-only child process for real crash testing (SEC-05 Phase 4A-R2). It runs a
// genuine format-2 commit through the production-internal store and terminates
// itself with SIGKILL at the named durable boundary via the production onStep
// seam. There is deliberately NO try/finally and NO lock release: an abrupt
// process death must leave the on-disk state (including the held lock) exactly as
// a real crash would, so a fresh process can validate recovery.
import { createFormatV2Store } from '../../continuity/internal/trust-format-v2.js';

const env = { NOOSPHERE_HOME: process.env.CRASH_HOME, NOOSPHERE_OWNER_SCOPE: process.env.CRASH_SCOPE };
const store = createFormatV2Store({ env });
const binding = await store.createProjectBinding(process.env.CRASH_PROJECT);
const crashAt = process.env.CRASH_AT;

const onStep = (state) => {
  // SIGKILL is delivered before the write of the next boundary; the current
  // boundary's artifact is already fsync'd.
  if (state === crashAt) process.kill(process.pid, 'SIGKILL');
};

if (process.env.CRASH_TRANSITION === 'revoked') {
  await store.commitRevocation({
    binding,
    slot: process.env.CRASH_SLOT,
    sourceOrigin: `cli:trust-revoke:${process.env.CRASH_SLOT}`,
    onStep,
  });
} else {
  await store.commitTransaction({
    binding,
    slot: process.env.CRASH_SLOT,
    rawBytes: process.env.CRASH_BYTES,
    sourceOrigin: 'crash-child',
    onStep,
  });
}

// Reached only if crashAt never matched a boundary — signal a clean finish.
process.exit(0);
