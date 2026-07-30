import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { AUTH_DOMAINS, sealRecord } from '../continuity/internal/authenticated-records.js';
import { deriveReplayIdentity } from '../continuity/internal/replay/identity.js';
import { loadReplayKey, replayKeyId } from '../continuity/internal/replay/key.js';
import { observeReplay } from '../continuity/internal/replay/observe.js';
import {
  readReplayRecord,
  replayProjectPaths,
  writeReplayRecord,
} from '../continuity/internal/replay/store.js';
import { assertForciblyTerminated } from './helpers/child-crash.js';

const PROJECT = `sha256:${'1'.repeat(64)}`;
const RECALL = `sha256:${'2'.repeat(64)}`;
const CONTENT = 'crash-safe recalled memory';
const EVENT = '11111111-1111-4111-8111-111111111111';
const NEXT_EVENT = '22222222-2222-4222-8222-222222222222';
const THIRD_EVENT = '33333333-3333-4333-8333-333333333333';
const OBSERVED_AT = '2026-07-29T17:00:00.000Z';
const BOUNDARIES = [
  'prepared',
  'record-committed',
  'manifest-committed',
  'complete',
];
const temporary = [];

after(async () => {
  await Promise.all(temporary.map(directory =>
    fs.rm(directory, { recursive: true, force: true })));
});

function input(env, overrides = {}) {
  return {
    env,
    projectIdentityDigest: PROJECT,
    slot: 'ordinary',
    content: CONTENT,
    recallIdentity: RECALL,
    origin: 'walrus-recall',
    observedAt: OBSERVED_AT,
    eventId: EVENT,
    duplicateCandidate: false,
    ...overrides,
  };
}

async function clearStrandedLocks(env) {
  const paths = replayProjectPaths({ env, projectIdentityDigest: PROJECT });
  const { replayIdentity } = deriveReplayIdentity({
    projectIdentityDigest: PROJECT,
    slot: 'ordinary',
    content: CONTENT,
  });
  await fs.unlink(path.join(paths.locks, `${replayIdentity.slice(7)}.lock`));
  await fs.unlink(path.join(paths.project, 'ledger.lock'));
}

async function crashAt(home, boundary) {
  const child = spawnSync(
    process.execPath,
    ['tests/helpers/replay-crash-child.mjs'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        REPLAY_CRASH_HOME: home,
        REPLAY_CRASH_AT: boundary,
        REPLAY_PROJECT: PROJECT,
        REPLAY_CONTENT: CONTENT,
        REPLAY_RECALL: RECALL,
        REPLAY_OBSERVED_AT: OBSERVED_AT,
        REPLAY_EVENT_ID: EVENT,
      },
      encoding: 'utf8',
    },
  );
  assertForciblyTerminated(child, { context: child.stderr });
}

async function snapshotTree(root) {
  const snapshot = {};
  async function visit(directory, relative = '') {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const nextRelative = path.join(relative, entry.name);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        snapshot[`${nextRelative}/`] = null;
        await visit(absolute, nextRelative);
      } else {
        snapshot[nextRelative] = (await fs.readFile(absolute)).toString('hex');
      }
    }
  }
  await visit(root);
  return snapshot;
}

for (const pass of [1, 2]) {
  for (const boundary of BOUNDARIES) {
    test(`fresh process recovers ${boundary} exactly once (pass ${pass})`, async () => {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-replay-crash-'));
      temporary.push(home);
      const env = { NOOSPHERE_HOME: home };
      await crashAt(home, boundary);
      await clearStrandedLocks(env);

      const recovered = await observeReplay(input(env));
      assert.equal(recovered.record.replayCount, 1);
      assert.equal(recovered.record.recordGeneration, 1);
      assert.equal(recovered.record.firstSeen.eventId, EVENT);
      assert.equal(recovered.record.lastSeen.eventId, EVENT);

      const idempotent = await observeReplay(input(env));
      assert.equal(idempotent.record.replayCount, 1);
      assert.equal(idempotent.record.firstSeen.eventId, EVENT);

      const next = await observeReplay(input(env, {
        eventId: NEXT_EVENT,
        observedAt: '2026-07-29T17:01:00.000Z',
      }));
      assert.equal(next.record.replayCount, 2);
      assert.equal(next.record.recordGeneration, 2);
      assert.equal(next.record.firstSeen.eventId, EVENT);

      const paths = replayProjectPaths({
        env,
        projectIdentityDigest: PROJECT,
      });
      const operations = (await fs.readdir(paths.journals)).sort();
      assert.equal(operations.length, 2);
      for (const operation of operations) {
        assert.deepEqual(
          (await fs.readdir(path.join(paths.journals, operation))).sort(),
          [
            '00-prepared.json',
            '01-record-committed.json',
            '02-manifest-committed.json',
            '03-complete.json',
          ],
        );
      }
    });
  }
}

test('recovery refuses a third authenticated artifact state without mutation', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-replay-third-'));
  temporary.push(home);
  const env = { NOOSPHERE_HOME: home };
  await observeReplay(input(env, {
    eventId: NEXT_EVENT,
    observedAt: '2026-07-29T16:59:00.000Z',
  }));
  await crashAt(home, 'prepared');
  await clearStrandedLocks(env);

  const identity = deriveReplayIdentity({
    projectIdentityDigest: PROJECT,
    slot: 'ordinary',
    content: CONTENT,
  });
  const key = await loadReplayKey({ env });
  const prior = await readReplayRecord({
    env,
    key,
    projectIdentityDigest: PROJECT,
    replayIdentity: identity.replayIdentity,
  });
  const third = sealRecord(key, AUTH_DOMAINS.replayRecord, {
    ...prior,
    recallIdentity: RECALL,
    lastSeen: {
      eventId: THIRD_EVENT,
      observedAt: '2026-07-29T17:00:30.000Z',
      recallIdentity: RECALL,
    },
    replayCount: 2,
    state: 'Replayed',
    lastClassification: 'SEEN',
    recordGeneration: 2,
    keyId: replayKeyId(key),
    mac: undefined,
  });
  await writeReplayRecord({
    env,
    projectIdentityDigest: PROJECT,
    record: third,
  });
  const paths = replayProjectPaths({ env, projectIdentityDigest: PROJECT });
  const before = await snapshotTree(paths.project);

  await assert.rejects(
    observeReplay(input(env)),
    error => error.code === 'replay-journal-third-state',
  );
  assert.deepEqual(await snapshotTree(paths.project), before);
});
