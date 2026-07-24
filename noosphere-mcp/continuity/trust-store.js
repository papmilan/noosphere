// SEC-05 trust store — PRODUCTION surface.
//
// M-3 (PR-H): production code (index.js, ollama.js, any adapter) may consume
// ONLY the authority-decision interface below. The low-level writers
// (putSlotRecord / ensureProjectIdentity / ensureMachineKey) and internal
// helpers live in ./trust-store-internal.js and are test/internal only — they
// are deliberately NOT re-exported here so no production caller can mint or
// mutate trust records. The sole production capability is asking whether a
// slot's exact bytes are authenticated (isSlotAuthoritative), which never makes
// an authority decision more permissive.
export {
  isSlotAuthoritative,
  TRUST_SLOTS,
  PHASE1_NORM_ALGO,
  PHASE1_NORM_VERSION,
  TrustStoreError,
} from './trust-store-internal.js';
