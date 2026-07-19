export function assessResumeFreshness({
  latestSessionActivityAt = null,
  latestCheckpointAt = null,
  sessionStatus = null,
} = {}) {
  const warnings = [];
  if (sessionStatus === 'interrupted') {
    warnings.push({
      code: 'interrupted-session',
      message: 'The latest session was interrupted; no final handoff is implied.',
    });
  }
  if (latestSessionActivityAt && (!latestCheckpointAt || latestSessionActivityAt > latestCheckpointAt)) {
    warnings.push({
      code: 'checkpoint-predates-session',
      message: 'Session activity is newer than the latest durable checkpoint.',
    });
  }
  if (!latestCheckpointAt) {
    warnings.push({
      code: 'no-durable-checkpoint',
      message: 'No durable checkpoint exists for this project.',
    });
  }
  return {
    freshness: warnings.length > 0 ? 'incomplete' : 'current',
    warnings,
  };
}
