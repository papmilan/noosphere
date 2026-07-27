export const RESTORE_SLOTS = Object.freeze({
  'master-prompt': Object.freeze({
    query: 'master prompt original project instruction',
    actionType: 'master-prompt',
    destination: '.noosphere/master-prompt.md',
  }),
  instructions: Object.freeze({
    query: 'project protocol instructions',
    actionType: 'project-instructions',
    destination: '.noosphere/instructions.md',
  }),
  baseline: Object.freeze({
    query: 'project baseline git history',
    actionType: 'project-baseline',
    destination: '.noosphere/baseline.md',
  }),
});

export const CANDIDATE_ID_PATTERN = /^[a-z2-7]{51}[aq]$/;
export const ACTIVE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const AUTHORITY_PAYLOAD_BYTES = 1_048_576;
export const OBSERVATION_PAYLOAD_BYTES = 8_388_608;
export const RESTORE_RECORD_BYTES = 65_536;
export const RESTORE_CONFIRMATION_BYTES = 256;
