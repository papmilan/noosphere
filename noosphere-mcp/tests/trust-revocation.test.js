import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { AUTH_DOMAINS } from '../continuity/internal/authenticated-records.js';
import { canonicalize } from '../continuity/trust-store-internal.js';
import {
  buildRevokedGeneration,
  validateTrustGeneration,
} from '../continuity/internal/trust-generation.js';
import { createFormatV2Store } from '../continuity/internal/trust-format-v2.js';
import { isSlotAuthoritative } from '../continuity/trust-store.js';

const temporary = [];
const ORIGINAL = Buffer.from('approved original', 'utf8');
const REAPPROVED = Buffer.from('approved replacement', 'utf8');

after(async () => {
  await Promise.all(temporary.map(directory =>
    fs.rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-revoke-home-'));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-revoke-project-'));
  temporary.push(home, project);
  const env = {
    NOOSPHERE_HOME: home,
    NOOSPHERE_OWNER_SCOPE: 'phase4c-owner',
  };
  const store = createFormatV2Store({ env, now: new Date('2026-07-27T12:00:00Z') });
  const binding = await store.createProjectBinding(project);
  return { binding, env, home, project, store };
}

function tombstoneInput(overrides = {}) {
  return {
    recordId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    projectIdentityDigest: `sha256:${'b'.repeat(64)}`,
    ownerScope: 'uid:1000',
    slot: 'baseline',
    generation: 2,
    previousGeneration: 1,
    previousCurrentRecordId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    previousCurrentRecordHash: 'd'.repeat(64),
    keyIdentity: 'e'.repeat(64),
    auditEventId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    createdAt: '2026-07-27T12:00:00Z',
    sourceOrigin: 'cli:trust-revoke:baseline',
    ...overrides,
  };
}

describe('SEC-05 Phase 4C — append-only revocation', () => {
  it('builds the one exact canonical tombstone shape', () => {
    const tombstone = buildRevokedGeneration(tombstoneInput());

    assert.deepEqual(Object.keys(tombstone).sort(), [
      'auditEventId',
      'createdAt',
      'domain',
      'generation',
      'keyIdentity',
      'ownerScope',
      'previousCurrentRecordHash',
      'previousCurrentRecordId',
      'previousGeneration',
      'projectIdentityDigest',
      'recordId',
      'schema',
      'slot',
      'sourceOrigin',
      'transition',
      'version',
    ].sort());
    assert.equal(tombstone.domain, AUTH_DOMAINS.revokedGeneration);
    assert.equal(tombstone.schema, 'noosphere.sec05.revoked-generation');
    assert.equal(tombstone.version, 1);
    assert.equal(tombstone.transition, 'revoked');
    assert.equal(validateTrustGeneration(tombstone), tombstone);
  });

  it('rejects forbidden, null, inherited, unknown, and omitted tombstone fields', () => {
    for (const forbidden of [
      'rawHash',
      'contentHash',
      'byteLength',
      'normAlgo',
      'normVersion',
    ]) {
      assert.throws(
        () => validateTrustGeneration({
          ...buildRevokedGeneration(tombstoneInput()),
          [forbidden]: null,
        }),
        error => error.code === 'revoked-generation-invalid',
        forbidden,
      );
      const inherited = Object.create({ [forbidden]: 'inherited' });
      Object.assign(inherited, buildRevokedGeneration(tombstoneInput()));
      assert.throws(
        () => validateTrustGeneration(inherited),
        error => error.code === 'revoked-generation-invalid',
        `inherited ${forbidden}`,
      );
    }
    assert.throws(
      () => validateTrustGeneration({
        ...buildRevokedGeneration(tombstoneInput()),
        reason: 'alternate field',
      }),
      error => error.code === 'revoked-generation-invalid',
    );
    const omitted = { ...buildRevokedGeneration(tombstoneInput()) };
    delete omitted.previousCurrentRecordHash;
    assert.throws(
      () => validateTrustGeneration(omitted),
      error => error.code === 'revoked-generation-invalid',
    );
  });

  it('appends N+1 tombstone, is idempotent, and reapproves only at N+2', async () => {
    const context = await fixture();
    const approval = await context.store.commitApproval({
      binding: context.binding,
      slot: 'baseline',
      rawBytes: ORIGINAL,
      sourceOrigin: 'cli:trust-approve:baseline',
    });
    assert.equal(approval.generation.generation, 1);
    assert.equal(
      await isSlotAuthoritative({
        projectRoot: context.project,
        slot: 'baseline',
        rawBytes: ORIGINAL,
        env: context.env,
      }),
      true,
    );

    const revocation = await context.store.commitRevocation({
      binding: context.binding,
      slot: 'baseline',
      sourceOrigin: 'cli:trust-revoke:baseline',
    });
    assert.equal(revocation.status, 'revoked');
    assert.equal(revocation.generation.generation, 2);
    assert.equal(revocation.generation.previousGeneration, 1);
    validateTrustGeneration(revocation.generation);
    for (const bytes of [ORIGINAL, REAPPROVED, Buffer.alloc(0)]) {
      assert.equal(
        await isSlotAuthoritative({
          projectRoot: context.project,
          slot: 'baseline',
          rawBytes: bytes,
          env: context.env,
        }),
        false,
      );
    }

    const recordsDirectory = context.store.pathFor(
      context.binding,
      'records/baseline',
    );
    const beforeRepeat = (await fs.readdir(recordsDirectory)).sort();
    const repeated = await context.store.commitRevocation({
      binding: context.binding,
      slot: 'baseline',
      sourceOrigin: 'cli:trust-revoke:baseline',
    });
    assert.equal(repeated.status, 'already-revoked');
    assert.equal(repeated.generation.generation, 2);
    assert.deepEqual((await fs.readdir(recordsDirectory)).sort(), beforeRepeat);

    const reapproval = await context.store.commitApproval({
      binding: context.binding,
      slot: 'baseline',
      rawBytes: REAPPROVED,
      sourceOrigin: 'cli:trust-approve:baseline',
    });
    assert.equal(reapproval.generation.generation, 3);
    assert.equal((await context.store.classifySlot({
      binding: context.binding,
      slot: 'baseline',
    })).state, 'approved');
    assert.equal(
      await isSlotAuthoritative({
        projectRoot: context.project,
        slot: 'baseline',
        rawBytes: REAPPROVED,
        env: context.env,
      }),
      true,
    );
    assert.equal(
      await isSlotAuthoritative({
        projectRoot: context.project,
        slot: 'baseline',
        rawBytes: ORIGINAL,
        env: context.env,
      }),
      false,
    );
  });

  it('refuses to revoke pristine-unapproved state', async () => {
    const context = await fixture();
    await assert.rejects(
      context.store.commitRevocation({
        binding: context.binding,
        slot: 'instructions',
        sourceOrigin: 'cli:trust-revoke:instructions',
      }),
      error => error.code === 'revocation-no-approved-generation',
    );
    assert.equal((await context.store.classifySlot({
      binding: context.binding,
      slot: 'instructions',
    })).state, 'pristine-unapproved');
  });

  it('classifies missing or rolled-back manifests with generation artifacts as invalid', async () => {
    const deleted = await fixture();
    await deleted.store.commitApproval({
      binding: deleted.binding,
      slot: 'master-prompt',
      rawBytes: ORIGINAL,
      sourceOrigin: 'cli:trust-approve:master-prompt',
    });
    await fs.rm(deleted.store.manifestPath(deleted.binding, 'master-prompt'));
    await assert.rejects(
      deleted.store.classifySlot({
        binding: deleted.binding,
        slot: 'master-prompt',
      }),
      error => error.code === 'authority-history-invalid',
    );

    const rolledBack = await fixture();
    await rolledBack.store.commitApproval({
      binding: rolledBack.binding,
      slot: 'instructions',
      rawBytes: ORIGINAL,
      sourceOrigin: 'cli:trust-approve:instructions',
    });
    const manifestFile = rolledBack.store.manifestPath(
      rolledBack.binding,
      'instructions',
    );
    const generationOneManifest = await fs.readFile(manifestFile);
    await rolledBack.store.commitApproval({
      binding: rolledBack.binding,
      slot: 'instructions',
      rawBytes: REAPPROVED,
      sourceOrigin: 'cli:trust-approve:instructions',
    });
    await fs.writeFile(manifestFile, generationOneManifest);
    await assert.rejects(
      rolledBack.store.classifySlot({
        binding: rolledBack.binding,
        slot: 'instructions',
      }),
      error => error.code === 'authority-history-invalid',
    );
  });

  it('quarantines a MAC-invalid tombstone and its authenticated incomplete journal', async () => {
    const context = await fixture();
    await context.store.commitApproval({
      binding: context.binding,
      slot: 'baseline',
      rawBytes: ORIGINAL,
      sourceOrigin: 'cli:trust-approve:baseline',
    });
    await assert.rejects(
      context.store.commitRevocation({
        binding: context.binding,
        slot: 'baseline',
        sourceOrigin: 'cli:trust-revoke:baseline',
        onStep: state => {
          if (state === 'record-created') {
            throw Object.assign(new Error('simulated crash'), { code: 'simulated-crash' });
          }
        },
      }),
      error => error.code === 'simulated-crash',
    );

    const transactions = context.store.pathFor(context.binding, 'transactions');
    const [journalName] = await fs.readdir(transactions);
    const journalFile = path.join(transactions, journalName);
    const journal = JSON.parse(await fs.readFile(journalFile, 'utf8'));
    const tombstoneFile = context.store.recordPath(
      context.binding,
      'baseline',
      journal.candidateGeneration,
      journal.auditEventId,
    );
    const tombstone = JSON.parse(await fs.readFile(tombstoneFile, 'utf8'));
    tombstone.mac = '0'.repeat(64);
    const tombstoneBytes = canonicalize(tombstone);
    await fs.writeFile(tombstoneFile, tombstoneBytes);

    const journalFields = {
      ...journal,
      recordHash: context.store._internal.hash(tombstoneBytes),
    };
    delete journalFields.mac;
    const resigned = await context.store._internal.signed(
      AUTH_DOMAINS.authorityJournal,
      journalFields,
    );
    await fs.writeFile(journalFile, canonicalize(resigned));

    await context.store.recover(context.binding, 'baseline');
    await fs.access(`${journalFile}.quarantine`);
    await fs.access(`${tombstoneFile}.quarantine`);
    assert.equal((await context.store.classifySlot({
      binding: context.binding,
      slot: 'baseline',
    })).state, 'approved');
  });
});
