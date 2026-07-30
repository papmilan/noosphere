export const REPLAY_RECORD_BYTES = 16 * 1024;
export const REPLAY_METADATA_BYTES = 64 * 1024;
export const REPLAY_KEY_BYTES = 32;
export const REPLAY_KEY_HEX_BYTES = REPLAY_KEY_BYTES * 2;

export const REPLAY_SLOTS = Object.freeze([
  'master-prompt',
  'instructions',
  'baseline',
  'followups',
  'ordinary',
]);

export const REPLAY_STATES = Object.freeze([
  'SeenOnce',
  'Replayed',
]);

export const REPLAY_CLASSIFICATIONS = Object.freeze([
  'NEW',
  'SEEN',
  'REPLAYED',
  'SUPPRESSED',
]);

export const REPLAY_ORIGINS = Object.freeze([
  'walrus-recall',
  'local-file-recall',
]);
