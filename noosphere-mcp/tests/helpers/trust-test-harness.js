// Test-only Phase 4A adapter. All authority logic lives in the production-
// internal module continuity/internal/trust-format-v2.js; this file adds ONLY
// test conveniences: exception-injection crash simulation (R1 — R2 replaces it
// with child-process SIGKILL) and adversarial state seeding. It ships nowhere
// (tests/ is excluded from package.json#files) and mints no authority.
import crypto from 'node:crypto';

import { createFormatV2Store } from '../../continuity/internal/trust-format-v2.js';
import { NORM_ALGO, NORM_VERSION } from '../../continuity/memory-safety.js';

const SOURCE = 'phase4a-test-harness';

export function createTrustTestHarness({ env = process.env, secureFileOptions = {}, now } = {}) {
  const store = createFormatV2Store({ env, secureFileOptions, now });
  const { writeExclusive, hmac, hash, contentHash, machineKeyId, scope, nowIso } = store._internal;

  // Exception-injection crash wrapper: throws after the named durable boundary
  // via the production onStep seam. The production commitTransaction has no
  // crash awareness; this is purely a test driver.
  async function commitTestTransaction({ binding, slot, rawBytes, crashAt } = {}) {
    return store.commitTransaction({
      binding, slot, rawBytes, sourceOrigin: SOURCE,
      onStep: (state) => {
        if (state === crashAt) throw Object.assign(new Error('simulated crash'), { code: 'simulated-crash' });
      },
    });
  }

  // Seed an audit event with no backing record/manifest to prove an audit event
  // alone never confers authority.
  async function writeOrphanAudit({ binding, slot, rawBytes }) {
    const eventId = crypto.randomUUID();
    const machineKey = await store.ensureMachineKey();
    const raw = Buffer.isBuffer(rawBytes) ? rawBytes : Buffer.from(String(rawBytes), 'utf8');
    const fields = { format: 2, type: 'audit-event', eventId, eventType: 'orphan-test', projectIdentity: binding.projectIdentity, ownerScope: scope(), slot, generation: 1, recordId: crypto.randomUUID(), recordHash: hash('absent-record'), previousGeneration: 0, previousRecordId: null, previousAuditEventId: null, previousAuditEventHash: null, normAlgo: NORM_ALGO, normVersion: NORM_VERSION, rawHash: hash(raw), contentHash: contentHash(raw), keyId: machineKeyId(machineKey), timestamp: nowIso() };
    await writeExclusive(store.auditPath(binding, eventId), { ...fields, mac: hmac(machineKey, 'audit-event', fields) });
  }

  return Object.freeze({ ...store, commitTestTransaction, writeOrphanAudit });
}
