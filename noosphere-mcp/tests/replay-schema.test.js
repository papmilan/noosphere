import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  AUTH_DOMAINS,
  sealRecord,
  verifyRecord,
} from '../continuity/internal/authenticated-records.js';
import { canonicalize } from '../continuity/trust-store-internal.js';
import { deriveReplayIdentity } from '../continuity/internal/replay/identity.js';

const schemaModule = await import(
  '../continuity/internal/replay/schema.js'
).catch(() => null);

const KEY = Buffer.alloc(32, 0x52);
const PROJECT = `sha256:${'a'.repeat(64)}`;
const KEY_ID = 'b'.repeat(64);
const OBSERVED_AT = '2026-07-29T15:00:00.000Z';

function replayRecord(overrides = {}) {
  const derived = deriveReplayIdentity({
    projectIdentityDigest: PROJECT,
    slot: 'ordinary',
    content: 'replayed memory',
  });
  const recallIdentity = `sha256:${'c'.repeat(64)}`;
  const eventId = randomUUID();
  const fields = {
    domain: AUTH_DOMAINS.replayRecord,
    schema: 'noosphere.replay-record',
    version: 1,
    replayIdentity: derived.replayIdentity,
    projectIdentityDigest: PROJECT,
    slot: 'ordinary',
    payloadDigest: derived.payloadDigest,
    recallIdentity,
    firstSeen: {
      eventId,
      observedAt: OBSERVED_AT,
      recallIdentity,
    },
    lastSeen: {
      eventId,
      observedAt: OBSERVED_AT,
      recallIdentity,
    },
    replayCount: 1,
    state: 'SeenOnce',
    lastClassification: 'NEW',
    origin: 'walrus-recall',
    recordGeneration: 1,
    keyId: KEY_ID,
    ...overrides,
  };
  return sealRecord(KEY, AUTH_DOMAINS.replayRecord, fields);
}

test('declares six replay-only authenticated domains', () => {
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(AUTH_DOMAINS).filter(([name]) => name.startsWith('replay')),
    ),
    {
      replayCatalog: 'noosphere.replay.catalog.v1',
      replayManifest: 'noosphere.replay.manifest.v1',
      replayRecord: 'noosphere.replay.record.v1',
      replayJournal: 'noosphere.replay.journal.v1',
      replayCheckpoint: 'noosphere.replay.retention.v1',
      replayLock: 'noosphere.replay.lock.v1',
    },
  );
});

test('replay domains reject every ordered authority/restore/replay substitution', () => {
  const entries = Object.entries(AUTH_DOMAINS);
  assert.equal(entries.length, 19);
  for (const [sourceName, sourceDomain] of entries) {
    const sealed = sealRecord(KEY, sourceDomain, {
      domain: sourceDomain,
      marker: sourceName,
    });
    for (const [targetName, targetDomain] of entries) {
      assert.equal(
        verifyRecord(KEY, targetDomain, sealed),
        sourceName === targetName,
        `${sourceName} -> ${targetName}`,
      );
    }
  }
});

test('parses one exact canonical authenticated replay record', () => {
  assert.ok(schemaModule, 'production replay schema module must exist');
  assert.equal(typeof schemaModule.parseReplayRecord, 'function');
  const sealed = replayRecord();
  const parsed = schemaModule.parseReplayRecord(
    Buffer.from(canonicalize(sealed), 'utf8'),
    {
      key: KEY,
      expectedProjectIdentityDigest: PROJECT,
      expectedReplayIdentity: sealed.replayIdentity,
      expectedKeyId: KEY_ID,
    },
  );
  assert.deepEqual(parsed, sealed);
});

test('rejects unknown, omitted, cross-domain, and inconsistent fields', () => {
  assert.ok(schemaModule, 'production replay schema module must exist');
  const parse = value => schemaModule.parseReplayRecord(
    Buffer.from(canonicalize(value), 'utf8'),
    {
      key: KEY,
      expectedProjectIdentityDigest: PROJECT,
      expectedReplayIdentity: value.replayIdentity,
      expectedKeyId: KEY_ID,
    },
  );

  for (const mutation of [
    record => ({ ...record, candidateId: 'a'.repeat(52) }),
    record => ({ ...record, candidatePath: '/tmp/candidate' }),
    record => ({ ...record, replayPayload: 'secret memory' }),
    record => {
      const { slot: omitted, ...rest } = record;
      return rest;
    },
    record => ({ ...record, domain: AUTH_DOMAINS.manifest }),
    record => ({ ...record, replayCount: 2 }),
    record => ({ ...record, recordGeneration: 2 }),
    record => ({
      ...record,
      lastSeen: { ...record.lastSeen, observedAt: '2026-07-29T14:59:59.000Z' },
    }),
  ]) {
    assert.throws(() => parse(mutation(replayRecord())));
  }
});

test('rejects noncanonical and oversized replay record bytes before use', () => {
  assert.ok(schemaModule, 'production replay schema module must exist');
  const sealed = replayRecord();
  const options = {
    key: KEY,
    expectedProjectIdentityDigest: PROJECT,
    expectedReplayIdentity: sealed.replayIdentity,
    expectedKeyId: KEY_ID,
  };
  assert.throws(
    () => schemaModule.parseReplayRecord(
      Buffer.from(`${JSON.stringify(sealed, null, 2)}\n`, 'utf8'),
      options,
    ),
    /canonical/,
  );
  assert.throws(
    () => schemaModule.parseReplayRecord(
      Buffer.alloc(16 * 1024 + 1, 0x20),
      options,
    ),
    /16384/,
  );
});

test('catalog accepts only a sorted unique list of canonical project digests', () => {
  assert.ok(schemaModule, 'production replay schema module must exist');
  const parse = projects => {
    const catalog = sealRecord(KEY, AUTH_DOMAINS.replayCatalog, {
      domain: AUTH_DOMAINS.replayCatalog,
      schema: 'noosphere.replay-catalog',
      version: 1,
      projects,
      keyId: KEY_ID,
    });
    return schemaModule.parseReplayCatalog(
      Buffer.from(canonicalize(catalog), 'utf8'),
      { key: KEY, expectedKeyId: KEY_ID },
    );
  };
  assert.deepEqual(parse([
    `sha256:${'a'.repeat(64)}`,
    `sha256:${'b'.repeat(64)}`,
  ]).projects, [
    `sha256:${'a'.repeat(64)}`,
    `sha256:${'b'.repeat(64)}`,
  ]);
  for (const invalid of [
    [`sha256:${'b'.repeat(64)}`, `sha256:${'a'.repeat(64)}`],
    [`sha256:${'a'.repeat(64)}`, `sha256:${'a'.repeat(64)}`],
    ['a'.repeat(64)],
  ]) {
    assert.throws(() => parse(invalid), /projects/);
  }
});
