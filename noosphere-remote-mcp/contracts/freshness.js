import { PROJECT_MEMORY_SCHEMA_VERSION } from './constants.js';

export function createFreshnessWarning(code, message) {
  return { schema_version: PROJECT_MEMORY_SCHEMA_VERSION, code, message };
}

export function assessResumeFreshness({
  latestSessionActivityAt = null,
  latestCheckpointAt = null,
  sessionStatus = null,
} = {}) {
  const warnings = [];
  const warning = createFreshnessWarning;
  if (!latestCheckpointAt) {
    warnings.push(warning('no-durable-checkpoint', 'No durable checkpoint exists for this project.'));
  }
  if (sessionStatus === 'interrupted') {
    warnings.push(warning('interrupted-session', 'The latest session was interrupted; no final handoff is implied.'));
  }
  if (latestCheckpointAt && latestSessionActivityAt > latestCheckpointAt) {
    warnings.push(warning('checkpoint-predates-session', 'Session activity is newer than the latest durable checkpoint.'));
  }
  return {
    freshness: warnings.some(({ code }) => code === 'no-durable-checkpoint' || code === 'interrupted-session') ? 'incomplete' : warnings.length ? 'stale' : 'fresh',
    warnings,
  };
}
