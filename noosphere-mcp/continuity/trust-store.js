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
import fs from 'node:fs/promises';

import { isSlotAuthoritative as isFormat1Authoritative } from './trust-store-internal.js';
import { FORMAT2_SLOTS, createFormatV2Store } from './internal/trust-format-v2.js';

export {
  TRUST_SLOTS,
  PHASE1_NORM_ALGO,
  PHASE1_NORM_VERSION,
  TrustStoreError,
} from './trust-store-internal.js';

// THE authority decision, Phase 4B edition.
//
// Format-2 (owner-approved through `noosphere trust approve`) is consulted
// first. Once a format-2 manifest exists for a slot it is the SOLE authority for
// that slot: a leftover Phase-1 record for the same slot is ignored, so anyone
// who can restore an old format-1 record cannot downgrade past a newer owner
// approval. Format-1 remains valid only while a slot has no format-2 manifest at
// all, so existing installs keep working until they re-approve.
//
// Every failure, at any layer, fails closed to false.
export async function isSlotAuthoritative(request) {
  const { projectRoot, slot, env = process.env, secureFileOptions = {}, rawBytes } = request;
  if (FORMAT2_SLOTS.includes(slot)) {
    const store = createFormatV2Store({ env, secureFileOptions });
    // Only an absent binding can select format 1. Any other binding state —
    // including a symlink, directory, unreadable file, or lookup failure — is
    // evidence of format-2 state and must fail closed rather than downgrade.
    // Resolve the binding path OUTSIDE the guarded lstat: bindingPath() calls
    // realpathSync(projectRoot), which throws ENOENT of its own for an
    // unresolvable project path. Inside the guard that ENOENT would be read as
    // "binding absent" and would downgrade to format 1 — a path-resolution
    // failure is not evidence that the owner never approved this slot.
    let bindingFile;
    try {
      bindingFile = store.bindingPath(projectRoot);
    } catch {
      return false;
    }
    let bindingAbsent = false;
    try {
      await fs.lstat(bindingFile);
    } catch (error) {
      if (error.code === 'ENOENT') bindingAbsent = true;
      else return false;
    }
    if (!bindingAbsent) {
      try {
        const binding = await store.readProjectBinding(projectRoot);
        const manifest = await store.readManifest(binding, slot);
        // A bound project with no manifest for THIS slot has never approved it
        // under format-2; its Phase-1 record (if any) still governs that slot.
        // Known limitation until 4C retires format-1: someone who can delete
        // inside the owner-only trust root AND kept a superseded Phase-1 record
        // can force this fallback. Both artifacts are owner-minted, so this
        // reverts to older owner-approved bytes; it never authorizes new ones.
        if (manifest) return await store.isFormat2Authoritative({ binding, slot, rawBytes });
      } catch {
        return false;
      }
    }
  }
  return isFormat1Authoritative(request);
}
