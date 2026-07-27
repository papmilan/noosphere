// SEC-05 trust store — PRODUCTION surface.
//
// M-3 (PR-H): production code (index.js, ollama.js, any adapter) may consume
// ONLY the authority-decision interface below. The low-level writers
// (putSlotRecord / ensureProjectIdentity / ensureMachineKey), the format-2
// transaction machinery, and the owner-approval service live in
// ./trust-store-internal.js and ./internal/* and are deliberately NOT re-exported
// here, so no production caller — and no package consumer — can mint or mutate
// trust records. The sole production capability is asking whether a slot's exact
// bytes are authenticated (isSlotAuthoritative), which never makes an authority
// decision more permissive.
import { FORMAT2_SLOTS, createFormatV2Store } from './internal/trust-format-v2.js';

export {
  TRUST_SLOTS,
  PHASE1_NORM_ALGO,
  PHASE1_NORM_VERSION,
  TrustStoreError,
} from './trust-store-internal.js';

// THE authority decision, Phase 4C edition. Loading this dispatcher is the
// irreversible format-1 retirement event: only current authenticated Phase 4C
// state can authorize bytes. Legacy state remains available solely through the
// internal, read-only migration inventory.
//
// Every failure, at any layer, fails closed to false.
export async function isSlotAuthoritative(request) {
  const { projectRoot, slot, env = process.env, secureFileOptions = {}, rawBytes } = request;
  // Empty content authorizes nothing. Format 1 has no such check of its own — a
  // legacy record minted over empty bytes hashes fine and would make EVERY
  // empty-or-degraded read of that slot authoritative — and callers that map an
  // unusable slot to empty bytes rely on this being an invariant rather than an
  // accident. approveSlot refuses to mint one (approval-empty-slot); this is the
  // matching guard on the decision side, where it applies to both formats.
  // Fail closed on the guard itself: Buffer.byteLength THROWS for a number,
  // object, or array, and an authority decision must never propagate an
  // exception where false is the safe answer. Only Buffer and string are
  // supported inputs; anything else is not a slot's bytes.
  if (!Buffer.isBuffer(rawBytes) && typeof rawBytes !== 'string') return false;
  if (Buffer.byteLength(rawBytes) === 0) return false;
  if (!FORMAT2_SLOTS.includes(slot)) return false;
  try {
    const store = createFormatV2Store({ env, secureFileOptions });
    const binding = await store.readProjectBinding(projectRoot);
    return await store.isFormat2Authoritative({ binding, slot, rawBytes });
  } catch {
    return false;
  }
}
