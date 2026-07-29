import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { createFormatV2Store } from '../continuity/internal/trust-format-v2.js';
import { canonicalize } from '../continuity/trust-store-internal.js';
import {
  AUTH_DOMAINS,
  authenticatedMac,
  sealRecord,
  verifyRecord,
} from '../continuity/internal/authenticated-records.js';

const KEY = Buffer.alloc(32, 0x41);
const temporary = [];

after(async () => {
  await Promise.all(temporary.map(directory =>
    fs.rm(directory, { recursive: true, force: true })));
});

function recordFor(domain) {
  return Object.freeze({
    domain,
    format: 2,
    generation: 1,
    slot: 'baseline',
  });
}

describe('SEC-05 Phase 4C — authenticated record domains', () => {
  it('uses canonical-json([domain, record-without-mac]) as the complete MAC input', () => {
    const domain = AUTH_DOMAINS.approvedGeneration;
    const record = recordFor(domain);
    const expected = createHmac('sha256', KEY)
      .update(canonicalize([domain, record]), 'utf8')
      .digest('hex');

    assert.equal(authenticatedMac(KEY, domain, record), expected);
  });

  it('requires the stored domain to equal the independently supplied domain', () => {
    const sourceDomain = AUTH_DOMAINS.approvedGeneration;
    const sealed = sealRecord(KEY, sourceDomain, recordFor(sourceDomain));
    const substituted = {
      ...sealed,
      domain: AUTH_DOMAINS.revokedGeneration,
    };

    assert.equal(verifyRecord(KEY, sourceDomain, substituted), false);
    assert.equal(verifyRecord(KEY, AUTH_DOMAINS.revokedGeneration, substituted), false);
    assert.throws(
      () => sealRecord(KEY, sourceDomain, recordFor(AUTH_DOMAINS.revokedGeneration)),
      /record domain does not match expected domain/,
    );
  });

  it('rejects every ordered cross-domain substitution', () => {
    const entries = Object.entries(AUTH_DOMAINS);
    assert.equal(entries.length, 18);

    for (const [sourceName, sourceDomain] of entries) {
      const sealed = sealRecord(KEY, sourceDomain, recordFor(sourceDomain));
      for (const [targetName, targetDomain] of entries) {
        assert.equal(
          verifyRecord(KEY, targetDomain, sealed),
          sourceName === targetName,
          `${sourceName} -> ${targetName}`,
        );
      }
    }
  });

  it('binds every authority artifact to its exact domain and project identity digest', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-4c-domain-home-'));
    const project = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-4c-domain-project-'));
    temporary.push(home, project);
    const store = createFormatV2Store({
      env: {
        NOOSPHERE_HOME: home,
        NOOSPHERE_OWNER_SCOPE: 'phase4c-owner',
      },
    });
    const binding = await store.createProjectBinding(project);
    const identityDigest = await store.canonicalProjectIdentityDigest(project);
    const machineKey = await store.ensureMachineKey();
    let observedLock;
    let observedJournal;

    await assert.rejects(
      store.commitTransaction({
        binding,
        projectRoot: project,
        slot: 'baseline',
        rawBytes: Buffer.from('first', 'utf8'),
        sourceOrigin: 'test:phase4c',
        onStep: async state => {
          if (state !== 'journal-prepared') return;
          observedLock = JSON.parse(await fs.readFile(store.lockPath(binding, 'baseline'), 'utf8'));
          const [journalName] = await fs.readdir(store.pathFor(binding, 'transactions'));
          observedJournal = JSON.parse(await fs.readFile(
            path.join(store.pathFor(binding, 'transactions'), journalName),
            'utf8',
          ));
          throw Object.assign(new Error('stop after observation'), { code: 'observed' });
        },
      }),
      error => error.code === 'observed',
    );

    assert.equal(observedLock.domain, AUTH_DOMAINS.slotLock);
    assert.equal(observedLock.projectIdentityDigest, identityDigest);
    assert.equal(verifyRecord(machineKey, AUTH_DOMAINS.slotLock, observedLock), true);
    assert.equal(observedJournal.domain, AUTH_DOMAINS.authorityJournal);
    assert.equal(observedJournal.projectIdentityDigest, identityDigest);
    assert.equal(verifyRecord(machineKey, AUTH_DOMAINS.authorityJournal, observedJournal), true);

    await fs.rm(store.journalPath(binding, observedJournal.transactionId));
    const committed = await store.commitTransaction({
      binding,
      projectRoot: project,
      slot: 'baseline',
      rawBytes: Buffer.from('second', 'utf8'),
      sourceOrigin: 'test:phase4c',
    });
    for (const [record, domain] of [
      [committed.record, AUTH_DOMAINS.approvedGeneration],
      [committed.audit, AUTH_DOMAINS.audit],
      [committed.manifest, AUTH_DOMAINS.manifest],
    ]) {
      assert.equal(record.domain, domain);
      assert.equal(record.projectIdentityDigest, identityDigest);
      assert.equal(verifyRecord(machineKey, domain, record), true);
    }

    const foreignDigest = `sha256:${'d'.repeat(64)}`;
    const forgedRecordFields = {
      ...committed.record,
      projectIdentityDigest: foreignDigest,
    };
    delete forgedRecordFields.mac;
    const forgedRecord = {
      ...forgedRecordFields,
      mac: authenticatedMac(
        machineKey,
        AUTH_DOMAINS.approvedGeneration,
        forgedRecordFields,
      ),
    };
    const recordFile = store.recordPath(
      binding,
      'baseline',
      committed.record.generation,
      committed.audit.eventId,
    );
    await fs.writeFile(recordFile, canonicalize(forgedRecord));
    await assert.rejects(
      store.readImmutableRecord(recordFile),
      error => error.code === 'project-identity-invalid',
    );

    const forgedAuditFields = {
      ...committed.audit,
      projectIdentityDigest: foreignDigest,
    };
    delete forgedAuditFields.mac;
    const forgedAudit = {
      ...forgedAuditFields,
      mac: authenticatedMac(machineKey, AUTH_DOMAINS.audit, forgedAuditFields),
    };
    await fs.writeFile(
      store.auditPath(binding, committed.audit.eventId),
      canonicalize(forgedAudit),
    );
    await assert.rejects(
      store.readAudit(binding, committed.audit.eventId),
      error => error.code === 'project-identity-invalid',
    );
  });
});
