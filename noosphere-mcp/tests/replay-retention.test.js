import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { deriveReplayIdentity } from '../continuity/internal/replay/identity.js';
import { loadReplayKey } from '../continuity/internal/replay/key.js';
import { observeReplay } from '../continuity/internal/replay/observe.js';
import {
  readReplayManifest,
  readReplayRecord,
  replayProjectPaths,
} from '../continuity/internal/replay/store.js';
import { canonicalize } from '../continuity/trust-store-internal.js';

const retentionModule = await import(
  '../continuity/internal/replay/retention.js'
).catch(() => null);

const NOW = '2026-07-29T18:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;
const temporary = [];

after(async () => {
  await Promise.all(temporary.map(directory =>
    fs.rm(directory, { recursive: true, force: true })));
});

function identity(number) {
  return `sha256:${number.toString(16).padStart(64, '0')}`;
}

function record(number, observedAt = NOW, remoteTimestamp = undefined) {
  return {
    replayIdentity: identity(number),
    recordGeneration: 3,
    replayCount: 3,
    state: 'Replayed',
    lastSeen: { observedAt },
    remoteTimestamp,
    ranking: Number.MAX_SAFE_INTEGER - number,
  };
}

test('record retention uses only local age then lexical replay identity', () => {
  assert.ok(retentionModule, 'production retention module must exist');
  const old = new Date(Date.parse(NOW) - 91 * DAY).toISOString();
  const boundary = new Date(Date.parse(NOW) - 90 * DAY).toISOString();
  const records = [
    record(3, old, '2099-01-01T00:00:00.000Z'),
    record(1, old, '1900-01-01T00:00:00.000Z'),
    record(2, boundary, '1900-01-01T00:00:00.000Z'),
  ];
  assert.deepEqual(
    retentionModule.selectReplayRecordEvictions(records, {
      now: NOW,
      insertingNewIdentity: false,
    }).map(item => [item.record.replayIdentity, item.reason]),
    [
      [identity(1), 'age'],
      [identity(3), 'age'],
    ],
  );
});

test('new identity retention leaves exactly 4,095 records before insertion', () => {
  assert.ok(retentionModule, 'production retention module must exist');
  const records = Array.from({ length: 4097 }, (_, index) =>
    record(index + 1));
  const evictions = retentionModule.selectReplayRecordEvictions(records, {
    now: NOW,
    insertingNewIdentity: true,
  });
  assert.equal(evictions.length, 2);
  assert.deepEqual(
    evictions.map(item => item.record.replayIdentity),
    [identity(1), identity(2)],
  );
  assert.ok(evictions.every(item => item.reason === 'count'));
});

test('retention accumulator is the exact normative canonical construction', () => {
  assert.ok(retentionModule, 'production retention module must exist');
  const prior = `sha256:${'a'.repeat(64)}`;
  const evicted = record(7, '2026-01-01T00:00:00.000Z');
  const expected = `sha256:${createHash('sha256').update(canonicalize([
    'noosphere.replay-retention.v1',
    prior,
    evicted.replayIdentity,
    evicted.recordGeneration,
    evicted.replayCount,
    evicted.state,
    evicted.lastSeen.observedAt,
    'age',
  ])).digest('hex')}`;
  assert.equal(
    retentionModule.nextRetentionAccumulator(prior, evicted, 'age'),
    expected,
  );
});

test('completed journal retention is 7 days and 1,024; incomplete is immortal', () => {
  assert.ok(retentionModule, 'production retention module must exist');
  const completed = Array.from({ length: 1026 }, (_, index) => ({
    operationId:
      `${(index + 1).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
    complete: true,
    latest: {
      transitionAt: new Date(Date.parse(NOW) - index * 60_000).toISOString(),
    },
  }));
  const old = {
    operationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    complete: true,
    latest: {
      transitionAt: new Date(Date.parse(NOW) - 8 * DAY).toISOString(),
    },
  };
  const incomplete = {
    operationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    complete: false,
    latest: {
      transitionAt: new Date(Date.parse(NOW) - 100 * DAY).toISOString(),
    },
  };
  const evicted = retentionModule.selectCompletedJournalEvictions(
    [...completed, old, incomplete],
    { now: NOW },
  );
  assert.equal(evicted.includes(incomplete.operationId), false);
  assert.equal(evicted.includes(old.operationId), true);
  assert.equal(1028 - evicted.length, 1025);
});

test('a production observation evicts old evidence and commits its checkpoint first', async () => {
  assert.ok(retentionModule, 'production retention module must exist');
  assert.equal(
    typeof retentionModule.readRetentionCheckpoint,
    'function',
    'authenticated checkpoint reader must exist',
  );
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-retention-'));
  temporary.push(home);
  const env = { NOOSPHERE_HOME: home };
  const projectIdentityDigest = `sha256:${'9'.repeat(64)}`;
  const common = {
    env,
    projectIdentityDigest,
    slot: 'ordinary',
    recallIdentity: `sha256:${'8'.repeat(64)}`,
    origin: 'walrus-recall',
    duplicateCandidate: false,
  };
  const oldContent = 'old local observation';
  const oldObservedAt =
    new Date(Date.parse(NOW) - 91 * DAY).toISOString();
  const old = await observeReplay({
    ...common,
    content: oldContent,
    observedAt: oldObservedAt,
    eventId: '88888888-8888-4888-8888-888888888888',
  });
  await observeReplay({
    ...common,
    content: 'new local observation',
    observedAt: NOW,
    eventId: '99999999-9999-4999-8999-999999999999',
  });

  const key = await loadReplayKey({ env });
  const oldIdentity = deriveReplayIdentity({
    projectIdentityDigest,
    slot: 'ordinary',
    content: oldContent,
  }).replayIdentity;
  assert.equal(await readReplayRecord({
    env,
    key,
    projectIdentityDigest,
    replayIdentity: oldIdentity,
  }), null);
  const checkpoint = await retentionModule.readRetentionCheckpoint({
    env,
    key,
    projectIdentityDigest,
  });
  assert.equal(checkpoint.totalEvictedRecords, 1);
  assert.equal(checkpoint.retentionGeneration, 1);
  assert.equal(
    checkpoint.accumulator,
    retentionModule.nextRetentionAccumulator(
      retentionModule.INITIAL_RETENTION_ACCUMULATOR,
      old.record,
      'age',
    ),
  );
  const manifest = await readReplayManifest({
    env,
    key,
    projectIdentityDigest,
  });
  assert.equal(manifest.recordCount, 1);
  assert.equal(
    manifest.retentionCheckpointDigest,
    retentionModule.retentionCheckpointDigest(checkpoint),
  );
});

for (const boundary of [
  'retention-prepared',
  'retention-checkpoint-committed',
  'retention-manifest-committed',
  'retention-record-removed',
  'retention-complete',
]) {
  test(`retention recovers a real process death at ${boundary}`, async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-retention-crash-'));
    temporary.push(home);
    const env = { NOOSPHERE_HOME: home };
    const projectIdentityDigest = `sha256:${'7'.repeat(64)}`;
    const oldContent = `old before ${boundary}`;
    const newContent = `new after ${boundary}`;
    const oldObservedAt =
      new Date(Date.parse(NOW) - 91 * DAY).toISOString();
    const common = {
      env,
      projectIdentityDigest,
      slot: 'ordinary',
      recallIdentity: `sha256:${'6'.repeat(64)}`,
      origin: 'walrus-recall',
      duplicateCandidate: false,
    };
    await observeReplay({
      ...common,
      content: oldContent,
      observedAt: oldObservedAt,
      eventId: '66666666-6666-4666-8666-666666666666',
    });
    const eventId = '77777777-7777-4777-8777-777777777777';
    const child = spawnSync(
      process.execPath,
      ['tests/helpers/replay-crash-child.mjs'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          REPLAY_CRASH_HOME: home,
          REPLAY_CRASH_AT: boundary,
          REPLAY_PROJECT: projectIdentityDigest,
          REPLAY_CONTENT: newContent,
          REPLAY_RECALL: common.recallIdentity,
          REPLAY_OBSERVED_AT: NOW,
          REPLAY_EVENT_ID: eventId,
        },
        encoding: 'utf8',
      },
    );
    assert.equal(child.status, null, child.stderr);
    assert.equal(child.signal, 'SIGKILL', child.stderr);

    const paths = replayProjectPaths({ env, projectIdentityDigest });
    for (const name of await fs.readdir(paths.locks)) {
      await fs.unlink(path.join(paths.locks, name));
    }
    await fs.unlink(path.join(paths.project, 'ledger.lock'));

    const recovered = await observeReplay({
      ...common,
      content: newContent,
      observedAt: NOW,
      eventId,
    });
    assert.equal(recovered.record.replayCount, 1);
    const key = await loadReplayKey({ env });
    const oldIdentity = deriveReplayIdentity({
      projectIdentityDigest,
      slot: 'ordinary',
      content: oldContent,
    }).replayIdentity;
    assert.equal(await readReplayRecord({
      env,
      key,
      projectIdentityDigest,
      replayIdentity: oldIdentity,
    }), null);
    const checkpoint = await retentionModule.readRetentionCheckpoint({
      env,
      key,
      projectIdentityDigest,
    });
    assert.equal(checkpoint.totalEvictedRecords, 1);
  });
}
