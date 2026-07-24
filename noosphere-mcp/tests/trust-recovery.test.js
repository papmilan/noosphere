import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { NORM_ALGO, NORM_VERSION } from '../continuity/memory-safety.js';
import { canonicalize } from '../continuity/trust-store-internal.js';
import { createTrustTestHarness } from './helpers/trust-test-harness.js';

const temporary = [];
after(async () => { await Promise.all(temporary.map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-phase4a-home-'));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-phase4a-project-'));
  temporary.push(home, project);
  const harness = createTrustTestHarness({ env: { NOOSPHERE_HOME: home, NOOSPHERE_OWNER_SCOPE: 'phase4-owner' } });
  return { harness, binding: await harness.createProjectBinding(project) };
}

describe('SEC-05 Phase 4A-R1 — audit-chain completeness and journal recovery', () => {
  // A MAC-valid chain whose head event claims generation 2 while terminating as
  // genesis (previousAuditEventId === null) must be rejected: the genesis link is
  // pinned to generation 1. This is forged with the machine key, so it proves the
  // structural check, not merely the MAC.
  it('rejects a forged genesis event at generation > 1', async () => {
    const { harness, binding } = await fixture();
    const slot = 'master-prompt';
    const { hmac, hash, writeExclusive, machineKeyId, scope, contentHash } = harness._internal;
    const machineKey = await harness.ensureMachineKey();
    const keyId = machineKeyId(machineKey);
    const recordId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const value = Buffer.from('forged');
    const at = new Date().toISOString();

    const rf = { format: 2, type: 'slot-record', recordId, projectIdentity: binding.projectIdentity, ownerScope: scope(), slot, generation: 2, rawHash: hash(value), contentHash: contentHash(value), normAlgo: NORM_ALGO, normVersion: NORM_VERSION, sourceOrigin: 'forge', approvalEventId: eventId, previousRecordId: null, auditEventId: eventId, approvedAt: at, keyId };
    const record = { ...rf, mac: hmac(machineKey, 'slot-record', rf) };
    await writeExclusive(harness.recordPath(binding, slot, 2, eventId), record);
    const recordHash = hash(canonicalize(record));

    const af = { format: 2, type: 'audit-event', eventId, eventType: 'forge', projectIdentity: binding.projectIdentity, ownerScope: scope(), slot, generation: 2, recordId, recordHash, previousGeneration: 0, previousRecordId: null, previousAuditEventId: null, previousAuditEventHash: null, normAlgo: NORM_ALGO, normVersion: NORM_VERSION, rawHash: rf.rawHash, contentHash: rf.contentHash, keyId, timestamp: at };
    const audit = { ...af, mac: hmac(machineKey, 'audit-event', af) };
    await writeExclusive(harness.auditPath(binding, eventId), audit);
    const auditHash = hash(canonicalize(audit));

    const mf = { format: 2, type: 'manifest', projectIdentity: binding.projectIdentity, ownerScope: scope(), slot, currentGeneration: 2, currentRecordId: recordId, currentRecordHash: recordHash, auditHeadId: eventId, auditHeadHash: auditHash, keyId };
    const manifest = { ...mf, mac: hmac(machineKey, 'manifest', mf) };
    await writeExclusive(harness.manifestPath(binding, slot), manifest);

    assert.equal(await harness.verifyAuditChain(binding, slot), false);
    assert.equal(await harness.isFormat2Authoritative({ binding, slot, rawBytes: value }), false);
  });

  it('quarantines a tampered incomplete journal whose referenced record is absent', async () => {
    const { harness, binding } = await fixture();
    const slot = 'master-prompt';
    const { signed } = harness._internal;
    const eventId = crypto.randomUUID();
    const fields = { format: 2, type: 'transaction-journal', transactionId: eventId, projectIdentity: binding.projectIdentity, ownerScope: harness._internal.scope(), slot, candidateGeneration: 1, priorManifestHash: null, recordId: crypto.randomUUID(), auditEventId: eventId, recordHash: harness._internal.hash('claims-a-record'), auditHash: null, state: 'record-created', keyId: harness._internal.machineKeyId(await harness.ensureMachineKey()) };
    await harness._internal.writeExclusive(harness.journalPath(binding, eventId), await signed('transaction-journal', fields));

    await harness.recover(binding, slot);
    await assert.rejects(fs.access(harness.journalPath(binding, eventId)));
    await fs.access(`${harness.journalPath(binding, eventId)}.quarantine`);
  });

  it('cleans up a superseded committed journal without touching current authority', async () => {
    const { harness, binding } = await fixture();
    const slot = 'master-prompt';
    await harness.commitTestTransaction({ binding, slot, rawBytes: 'gen1' });
    await harness.commitTestTransaction({ binding, slot, rawBytes: 'gen2' });
    // Re-forge a valid committed journal for the now-superseded generation 1.
    const eventId = crypto.randomUUID();
    const fields = { format: 2, type: 'transaction-journal', transactionId: eventId, projectIdentity: binding.projectIdentity, ownerScope: harness._internal.scope(), slot, candidateGeneration: 1, priorManifestHash: null, recordId: crypto.randomUUID(), auditEventId: eventId, recordHash: harness._internal.hash('old'), auditHash: harness._internal.hash('old'), state: 'manifest-committed', keyId: harness._internal.machineKeyId(await harness.ensureMachineKey()) };
    await harness._internal.writeExclusive(harness.journalPath(binding, eventId), await harness._internal.signed('transaction-journal', fields));

    await harness.recover(binding, slot);
    await assert.rejects(fs.access(harness.journalPath(binding, eventId)));
    assert.equal(await harness.isFormat2Authoritative({ binding, slot, rawBytes: 'gen2' }), true);
  });
});
