// Test-only child process for real restore-apply crash testing (SEC-05 Phase
// 4C, Task 8). It runs a genuine apply through the production-internal service
// and terminates itself with SIGKILL at the named journal boundary via the
// production afterJournalState seam. There is deliberately NO try/finally and NO
// lock release: an abrupt process death must leave the on-disk state (including
// the held slot lock and any temporary file) exactly as a real crash would, so a
// fresh process can validate recovery.
import { applyRestoreCandidate } from '../../continuity/internal/restore/apply-service.js';

const env = {
  NOOSPHERE_HOME: process.env.CRASH_HOME,
  NOOSPHERE_OWNER_SCOPE: process.env.CRASH_SCOPE,
};
const crashAt = process.env.CRASH_AT;

await applyRestoreCandidate({
  projectRoot: process.env.CRASH_PROJECT,
  env,
  candidateId: process.env.CRASH_CANDIDATE,
  confirm: () => true,
  afterJournalState: (state) => {
    if (state === crashAt) process.kill(process.pid, 'SIGKILL');
  },
});

// Reached only if crashAt never matched a boundary — signal a clean finish.
process.exit(0);
