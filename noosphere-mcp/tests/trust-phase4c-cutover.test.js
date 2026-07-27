import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { createFormatV2Store } from '../continuity/internal/trust-format-v2.js';
import { readLegacyTrustInventory } from '../continuity/internal/legacy-trust-inventory.js';
import { NORM_ALGO, NORM_VERSION, normalizeUntrusted } from '../continuity/memory-safety.js';
import { isSlotAuthoritative } from '../continuity/trust-store.js';
import {
  canonicalize,
  ensureMachineKey,
  machineKeyId,
  putSlotRecord,
} from '../continuity/trust-store-internal.js';

const temporary = [];
const BYTES = Buffer.from('phase 4c exact bytes', 'utf8');

after(async () => {
  await Promise.all(temporary.map(directory =>
    fs.rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-cutover-home-'));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-cutover-project-'));
  temporary.push(home, project);
  return {
    home,
    project,
    env: {
      NOOSPHERE_HOME: home,
      NOOSPHERE_OWNER_SCOPE: 'phase4c-owner',
    },
  };
}

async function publicAuthority({ project, env }, slot = 'master-prompt', rawBytes = BYTES) {
  return isSlotAuthoritative({ projectRoot: project, slot, rawBytes, env });
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function phase4bMac(key, type, fields) {
  return crypto.createHmac('sha256', key)
    .update(`noosphere/sec05/v2/${type}\0${canonicalize(fields)}`)
    .digest('hex');
}

async function writePhase4bApproval(context, slot = 'baseline') {
  const key = await ensureMachineKey(context.env);
  const projectIdentity = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const recordId = crypto.randomUUID();
  const realpath = await fs.realpath(context.project);
  const root = path.join(context.home, 'trust-v2');
  const bindingFields = {
    format: 2,
    type: 'project-binding',
    projectIdentity,
    ownerScope: context.env.NOOSPHERE_OWNER_SCOPE,
    realpathHash: sha256(realpath),
    keyId: machineKeyId(key),
  };
  const binding = {
    ...bindingFields,
    mac: phase4bMac(key, 'project-binding', bindingFields),
  };
  const bindingFile = path.join(root, 'bindings', `${sha256(realpath)}.json`);
  await fs.mkdir(path.dirname(bindingFile), { recursive: true, mode: 0o700 });
  await fs.writeFile(bindingFile, canonicalize(binding), { mode: 0o600 });

  const approvedAt = '2026-07-27T00:00:00Z';
  const recordFields = {
    format: 2,
    type: 'slot-record',
    recordId,
    projectIdentity,
    ownerScope: context.env.NOOSPHERE_OWNER_SCOPE,
    slot,
    generation: 1,
    rawHash: sha256(BYTES),
    contentHash: sha256(Buffer.from(normalizeUntrusted(BYTES.toString('utf8')), 'utf8')),
    normAlgo: NORM_ALGO,
    normVersion: NORM_VERSION,
    sourceOrigin: 'phase4b-fixture',
    approvalEventId: eventId,
    previousRecordId: null,
    auditEventId: eventId,
    approvedAt,
    keyId: machineKeyId(key),
  };
  const record = {
    ...recordFields,
    mac: phase4bMac(key, 'slot-record', recordFields),
  };
  const recordBytes = canonicalize(record);
  const auditFields = {
    format: 2,
    type: 'audit-event',
    eventId,
    eventType: 'phase4b-fixture',
    projectIdentity,
    ownerScope: context.env.NOOSPHERE_OWNER_SCOPE,
    slot,
    generation: 1,
    recordId,
    recordHash: sha256(recordBytes),
    previousGeneration: 0,
    previousRecordId: null,
    previousAuditEventId: null,
    previousAuditEventHash: null,
    normAlgo: NORM_ALGO,
    normVersion: NORM_VERSION,
    rawHash: record.rawHash,
    contentHash: record.contentHash,
    keyId: machineKeyId(key),
    timestamp: approvedAt,
  };
  const audit = {
    ...auditFields,
    mac: phase4bMac(key, 'audit-event', auditFields),
  };
  const auditBytes = canonicalize(audit);
  const manifestFields = {
    format: 2,
    type: 'manifest',
    projectIdentity,
    ownerScope: context.env.NOOSPHERE_OWNER_SCOPE,
    slot,
    currentGeneration: 1,
    currentRecordId: recordId,
    currentRecordHash: sha256(recordBytes),
    auditHeadId: eventId,
    auditHeadHash: sha256(auditBytes),
    keyId: machineKeyId(key),
  };
  const manifest = {
    ...manifestFields,
    mac: phase4bMac(key, 'manifest', manifestFields),
  };
  const projectRoot = path.join(root, 'projects', projectIdentity);
  await fs.mkdir(path.join(projectRoot, 'records', slot), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(projectRoot, 'audit', 'events'), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(projectRoot, 'manifests'), { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(projectRoot, 'records', slot, `1-${eventId}.json`),
    recordBytes,
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(projectRoot, 'audit', 'events', `${eventId}.json`),
    auditBytes,
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(projectRoot, 'manifests', `${slot}.json`),
    canonicalize(manifest),
    { mode: 0o600 },
  );
}

describe('SEC-05 Phase 4C — irreversible authority cutover', () => {
  it('makes a valid format-1 approval inert before migration inventory', async () => {
    const context = await fixture();
    await putSlotRecord({
      projectRoot: context.project,
      slot: 'master-prompt',
      rawBytes: BYTES,
      env: context.env,
    });

    assert.equal(await publicAuthority(context), false);
    const inventory = await readLegacyTrustInventory({
      root: context.project,
      env: context.env,
    });
    assert.equal(inventory.slots['master-prompt'].classification, 'eligible');
    assert.deepEqual(inventory.slots['master-prompt'].legacyFormats, ['format-1']);
    assert.equal('isSlotAuthoritative' in inventory, false);
  });

  it('never exposes the legacy-only followups slot as authority', async () => {
    const context = await fixture();
    await putSlotRecord({
      projectRoot: context.project,
      slot: 'followups',
      rawBytes: BYTES,
      env: context.env,
    });

    assert.equal(await publicAuthority(context, 'followups'), false);
  });

  it('treats a valid pre-4C format-2 approval as migration inventory only', async () => {
    const context = await fixture();
    await writePhase4bApproval(context);

    assert.equal(await publicAuthority(context, 'baseline'), false);
    const inventory = await readLegacyTrustInventory({
      root: context.project,
      env: context.env,
    });
    assert.equal(inventory.slots.baseline.classification, 'eligible');
    assert.deepEqual(inventory.slots.baseline.legacyFormats, ['phase4b-format-2']);
  });

  it('keeps format 1 inert after Phase 4C manifest deletion', async () => {
    const context = await fixture();
    await putSlotRecord({
      projectRoot: context.project,
      slot: 'master-prompt',
      rawBytes: BYTES,
      env: context.env,
    });
    const store = createFormatV2Store({ env: context.env });
    const binding = await store.createProjectBinding(context.project);
    await store.commitTransaction({
      binding,
      slot: 'master-prompt',
      rawBytes: BYTES,
      sourceOrigin: 'test:phase4c-cutover',
    });
    assert.equal(await publicAuthority(context), true);

    await fs.rm(store.manifestPath(binding, 'master-prompt'));
    assert.equal(await publicAuthority(context), false);
  });

  it('keeps format 1 inert after binding deletion or corruption', async () => {
    for (const mutation of ['delete', 'corrupt']) {
      const context = await fixture();
      await putSlotRecord({
        projectRoot: context.project,
        slot: 'master-prompt',
        rawBytes: BYTES,
        env: context.env,
      });
      const store = createFormatV2Store({ env: context.env });
      await store.createProjectBinding(context.project);
      if (mutation === 'delete') {
        await fs.rm(store.bindingPath(context.project));
      } else {
        await fs.writeFile(store.bindingPath(context.project), '{not-json');
      }

      assert.equal(await publicAuthority(context), false, mutation);
    }
  });

  it('authorizes only exact bytes selected by valid current Phase 4C state', async () => {
    const context = await fixture();
    const store = createFormatV2Store({ env: context.env });
    const binding = await store.createProjectBinding(context.project);
    await store.commitTransaction({
      binding,
      slot: 'baseline',
      rawBytes: BYTES,
      sourceOrigin: 'test:phase4c-cutover',
    });

    assert.equal(await publicAuthority(context, 'baseline'), true);
    assert.equal(
      await publicAuthority(context, 'baseline', Buffer.from('different', 'utf8')),
      false,
    );
  });
});
