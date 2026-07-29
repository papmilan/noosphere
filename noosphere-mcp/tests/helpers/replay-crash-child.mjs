import { observeReplay } from '../../continuity/internal/replay/observe.js';

const onStep = state => {
  if (state === process.env.REPLAY_CRASH_AT) {
    process.kill(process.pid, 'SIGKILL');
  }
};

await observeReplay({
  env: { NOOSPHERE_HOME: process.env.REPLAY_CRASH_HOME },
  projectIdentityDigest: process.env.REPLAY_PROJECT,
  slot: 'ordinary',
  content: process.env.REPLAY_CONTENT,
  recallIdentity: process.env.REPLAY_RECALL,
  origin: 'walrus-recall',
  observedAt: process.env.REPLAY_OBSERVED_AT,
  eventId: process.env.REPLAY_EVENT_ID,
  duplicateCandidate: false,
  onStep,
});

process.exit(0);
