export const SYNC_PROTOCOL_VERSION = 'noosphere.acp-sync/1';
export const RECONCILIATION_POLICY_VERSION = 'noosphere.acp-reconcile/1';
export const ACP_LIMITS = Object.freeze({
  snapshotBytes: 1_048_576,
  indexedSnapshotsPerProject: 10_000,
  concurrentHeadsPerProject: 32,
  ancestryEnvelopes: 200,
  indexedBytesPerProject: 268_435_456,
  liveConfirmations: 16,
});
