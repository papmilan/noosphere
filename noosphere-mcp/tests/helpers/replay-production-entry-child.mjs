import { PassThrough } from 'node:stream';

const env = {
  NOOSPHERE_HOME: process.env.REPLAY_ENTRY_HOME,
  NOOSPHERE_OWNER_SCOPE: process.env.REPLAY_ENTRY_SCOPE,
};
const projectRoot = process.env.REPLAY_ENTRY_PROJECT_ROOT;
const mode = process.env.REPLAY_ENTRY_MODE;

if (mode === 'restore-stage') {
  const { stageReplayAwareRestoreCandidate } = await import(
    '../../continuity/internal/replay/restore-stage.js'
  );
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  output.isTTY = true;
  await stageReplayAwareRestoreCandidate({
    env,
    projectRoot,
    slot: 'master-prompt',
    input,
    output,
    now: () => new Date('2026-07-29T19:30:00.000Z'),
    recallSource: async () => ({
      content: Buffer.from('production restore entry'),
      metadata: {
        actionId: 'restore-entry',
        actionType: 'master-prompt',
        agentId: null,
        timestamp: null,
        blobId: null,
      },
    }),
  });
} else if (mode === 'ordinary') {
  const { ingestOrdinaryRecall } = await import(
    '../../continuity/internal/replay/presentation.js'
  );
  await ingestOrdinaryRecall({
    env,
    projectRoot,
    now: () => new Date('2026-07-29T19:30:00.000Z'),
    response: {
      memories: [{
        action_id: 'ordinary-entry',
        content: 'production ordinary entry',
      }],
    },
  });
} else if (mode === 'context-refresh') {
  const { refreshContext } = await import('../../continuity/index.js');
  await refreshContext(projectRoot, {
    env,
    now: () => new Date('2026-07-29T19:30:00.000Z'),
  });
} else {
  throw new Error('unknown production replay entry mode');
}
