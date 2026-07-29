import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

import {
  AUTH_DOMAINS,
  sealRecord,
  verifyRecord,
} from '../continuity/internal/authenticated-records.js';

test('every replay domain rejects ordered authority/restore substitution', () => {
  const key = randomBytes(32);
  const replayDomains = [
    AUTH_DOMAINS.replayCatalog,
    AUTH_DOMAINS.replayManifest,
    AUTH_DOMAINS.replayRecord,
    AUTH_DOMAINS.replayJournal,
    AUTH_DOMAINS.replayCheckpoint,
    AUTH_DOMAINS.replayLock,
  ];
  const foreignDomains = Object.values(AUTH_DOMAINS)
    .filter(domain => !replayDomains.includes(domain));
  for (const sourceDomain of [...replayDomains, ...foreignDomains]) {
    const record = sealRecord(key, sourceDomain, {
      domain: sourceDomain,
      marker: 'ordered-domain-substitution',
    });
    for (const targetDomain of [...replayDomains, ...foreignDomains]) {
      assert.equal(
        verifyRecord(key, targetDomain, record),
        targetDomain === sourceDomain,
        `${sourceDomain} substituted into ${targetDomain}`,
      );
    }
  }
});
