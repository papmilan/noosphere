import { createHmac, timingSafeEqual } from 'node:crypto';

import { canonicalize } from '../trust-store-internal.js';

export const AUTH_DOMAINS = Object.freeze({
  projectBinding: 'noosphere/sec05/v2/project-binding',
  approvedGeneration: 'noosphere/sec05/v2/generation/approved',
  revokedGeneration: 'noosphere/sec05/v2/generation/revoked',
  manifest: 'noosphere/sec05/v2/authority-manifest',
  audit: 'noosphere/sec05/v2/authority-audit-event',
  authorityJournal: 'noosphere/sec05/v2/authority-transaction-journal',
  slotLock: 'noosphere/sec05/v2/authority-slot-lock',
  restoreCandidate: 'noosphere/sec05/v2/restore-candidate-envelope',
  restoreConfirmation: 'noosphere/sec05/v2/restore-confirmation-context',
  restoreApplyJournal: 'noosphere/sec05/v2/restore-apply-journal',
  restoreReceipt: 'noosphere/sec05/v2/restore-consumption-receipt',
  restoreConsumed: 'noosphere/sec05/v2/restore-consumed-candidate-marker',
  restoreCandidateIndexLock:
    'noosphere/sec05/v2/restore-candidate-index-lock',
  replayCatalog: 'noosphere.replay.catalog.v1',
  replayManifest: 'noosphere.replay.manifest.v1',
  replayRecord: 'noosphere.replay.record.v1',
  replayJournal: 'noosphere.replay.journal.v1',
  replayCheckpoint: 'noosphere.replay.retention.v1',
  replayLock: 'noosphere.replay.lock.v1',
});

function recordWithoutMac(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError('authenticated record must be an object');
  }
  const { mac: ignoredMac, ...withoutMac } = record;
  return withoutMac;
}

export function authenticatedMac(key, domain, record) {
  const withoutMac = recordWithoutMac(record);
  if (withoutMac.domain !== domain) {
    throw new TypeError('record domain does not match expected domain');
  }
  return createHmac('sha256', key)
    .update(canonicalize([domain, withoutMac]), 'utf8')
    .digest('hex');
}

export function sealRecord(key, domain, record) {
  const withoutMac = recordWithoutMac(record);
  return Object.freeze({
    ...withoutMac,
    mac: authenticatedMac(key, domain, withoutMac),
  });
}

export function verifyRecord(key, domain, record) {
  if (!record || record.domain !== domain ||
      typeof record.mac !== 'string' || !/^[0-9a-f]{64}$/.test(record.mac)) {
    return false;
  }
  try {
    const expected = Buffer.from(authenticatedMac(key, domain, record), 'hex');
    const actual = Buffer.from(record.mac, 'hex');
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
