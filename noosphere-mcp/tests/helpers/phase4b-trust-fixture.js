import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { NORM_ALGO, NORM_VERSION, normalizeUntrusted } from '../../continuity/memory-safety.js';
import {
  canonicalize,
  ensureMachineKey,
  machineKeyId,
} from '../../continuity/trust-store-internal.js';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function phase4bMac(key, type, fields) {
  return crypto.createHmac('sha256', key)
    .update(`noosphere/sec05/v2/${type}\0${canonicalize(fields)}`)
    .digest('hex');
}

export async function writePhase4bApproval({
  home,
  project,
  env,
  slot,
  rawBytes,
}) {
  const bytes = Buffer.from(rawBytes);
  const key = await ensureMachineKey(env);
  const projectIdentity = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const recordId = crypto.randomUUID();
  const realpath = await fs.realpath(project);
  const root = path.join(home, 'trust-v2');
  const common = {
    projectIdentity,
    ownerScope: env.NOOSPHERE_OWNER_SCOPE,
    keyId: machineKeyId(key),
  };
  const bindingFields = {
    format: 2,
    type: 'project-binding',
    ...common,
    realpathHash: sha256(realpath),
  };
  const binding = {
    ...bindingFields,
    mac: phase4bMac(key, 'project-binding', bindingFields),
  };
  const bindingFile = path.join(root, 'bindings', `${sha256(realpath)}.json`);
  await fs.mkdir(path.dirname(bindingFile), { recursive: true, mode: 0o700 });
  await fs.writeFile(bindingFile, canonicalize(binding), { mode: 0o600 });

  const createdAt = '2026-07-27T00:00:00Z';
  const recordFields = {
    format: 2,
    type: 'slot-record',
    recordId,
    ...common,
    slot,
    generation: 1,
    rawHash: sha256(bytes),
    contentHash: sha256(Buffer.from(normalizeUntrusted(bytes.toString('utf8')), 'utf8')),
    normAlgo: NORM_ALGO,
    normVersion: NORM_VERSION,
    sourceOrigin: 'phase4b-fixture',
    approvalEventId: eventId,
    previousRecordId: null,
    auditEventId: eventId,
    approvedAt: createdAt,
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
    ...common,
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
    timestamp: createdAt,
  };
  const audit = {
    ...auditFields,
    mac: phase4bMac(key, 'audit-event', auditFields),
  };
  const auditBytes = canonicalize(audit);
  const manifestFields = {
    format: 2,
    type: 'manifest',
    ...common,
    slot,
    currentGeneration: 1,
    currentRecordId: recordId,
    currentRecordHash: sha256(recordBytes),
    auditHeadId: eventId,
    auditHeadHash: sha256(auditBytes),
  };
  const manifest = {
    ...manifestFields,
    mac: phase4bMac(key, 'manifest', manifestFields),
  };
  const projectDirectory = path.join(root, 'projects', projectIdentity);
  await fs.mkdir(path.join(projectDirectory, 'records', slot), {
    recursive: true,
    mode: 0o700,
  });
  await fs.mkdir(path.join(projectDirectory, 'audit', 'events'), {
    recursive: true,
    mode: 0o700,
  });
  await fs.mkdir(path.join(projectDirectory, 'manifests'), {
    recursive: true,
    mode: 0o700,
  });
  await fs.writeFile(
    path.join(projectDirectory, 'records', slot, `1-${eventId}.json`),
    recordBytes,
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(projectDirectory, 'audit', 'events', `${eventId}.json`),
    auditBytes,
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(projectDirectory, 'manifests', `${slot}.json`),
    canonicalize(manifest),
    { mode: 0o600 },
  );
  return Object.freeze({ binding, manifest, record });
}
