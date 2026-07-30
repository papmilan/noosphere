import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { createFormatV2Store } from '../continuity/internal/trust-format-v2.js';
import { canonicalize } from '../continuity/trust-store-internal.js';
import { isSlotAuthoritative } from '../continuity/trust-store.js';

const observeModule = await import(
  '../continuity/internal/replay/observe.js'
).catch(() => null);
const storeModule = await import(
  '../continuity/internal/replay/store.js'
).catch(() => null);

const PROJECT = `sha256:${'a'.repeat(64)}`;
const RECALL_A = `sha256:${'b'.repeat(64)}`;
const RECALL_B = `sha256:${'c'.repeat(64)}`;
const EVENTS = [
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
];
const temporary = [];

after(async () => {
  await Promise.all(temporary.map(directory =>
    fs.rm(directory, { recursive: true, force: true })));
});

async function environment() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-replay-store-'));
  temporary.push(home);
  return { home, env: { NOOSPHERE_HOME: home } };
}

function observation(env, overrides = {}) {
  return {
    env,
    projectIdentityDigest: PROJECT,
    slot: 'ordinary',
    content: 'same recalled memory',
    recallIdentity: RECALL_A,
    origin: 'walrus-recall',
    observedAt: '2026-07-29T16:00:00.000Z',
    eventId: EVENTS[0],
    duplicateCandidate: false,
    ...overrides,
  };
}

test('observations persist monotonic count, generation, and immutable first-seen', async () => {
  assert.ok(observeModule, 'production replay observer must exist');
  const { env } = await environment();
  const first = await observeModule.observeReplay(observation(env));
  const second = await observeModule.observeReplay(observation(env, {
    recallIdentity: RECALL_B,
    observedAt: '2026-07-29T16:01:00.000Z',
    eventId: EVENTS[1],
  }));
  const third = await observeModule.observeReplay(observation(env, {
    observedAt: '2026-07-29T15:59:00.000Z',
    eventId: EVENTS[2],
  }));

  assert.equal(first.classification, 'NEW');
  assert.equal(second.classification, 'SEEN');
  assert.equal(third.classification, 'REPLAYED');
  assert.equal(third.record.replayCount, 3);
  assert.equal(third.record.recordGeneration, 3);
  assert.equal(third.record.state, 'Replayed');
  assert.deepEqual(third.record.firstSeen, first.record.firstSeen);
  assert.equal(third.record.lastSeen.eventId, EVENTS[2]);
  assert.equal(
    third.record.lastSeen.observedAt,
    '2026-07-29T16:01:00.000Z',
  );
  assert.equal(first.record.replayIdentity, second.record.replayIdentity);
  assert.equal(second.record.replayIdentity, third.record.replayIdentity);
});

test('store persists only authenticated bounded digest evidence', async () => {
  assert.ok(observeModule, 'production replay observer must exist');
  assert.ok(storeModule, 'production replay store must exist');
  const { home, env } = await environment();
  const observed = await observeModule.observeReplay(observation(env));
  const paths = storeModule.replayProjectPaths({
    env,
    projectIdentityDigest: PROJECT,
  });
  const rawRecord = await fs.readFile(
    path.join(paths.records, `${observed.record.replayIdentity.slice(7)}.json`),
    'utf8',
  );
  const manifest = JSON.parse(await fs.readFile(paths.manifest, 'utf8'));
  const catalog = JSON.parse(await fs.readFile(
    path.join(home, 'replay-v1', 'catalog.json'),
    'utf8',
  ));

  assert.equal(rawRecord.includes('same recalled memory'), false);
  assert.equal(rawRecord.includes('candidateId'), false);
  assert.equal(rawRecord.includes('candidatePath'), false);
  assert.equal(manifest.recordCount, 1);
  assert.deepEqual(catalog.projects, [PROJECT]);
  assert.equal(rawRecord, canonicalize(JSON.parse(rawRecord)));
});

test('corrupt replay record fails closed without rewriting it', async () => {
  assert.ok(observeModule, 'production replay observer must exist');
  assert.ok(storeModule, 'production replay store must exist');
  const { env } = await environment();
  const first = await observeModule.observeReplay(observation(env));
  const paths = storeModule.replayProjectPaths({
    env,
    projectIdentityDigest: PROJECT,
  });
  const recordFile = path.join(
    paths.records,
    `${first.record.replayIdentity.slice(7)}.json`,
  );
  await fs.writeFile(recordFile, '{"corrupt":true}', { mode: 0o600 });
  const before = await fs.readFile(recordFile);

  await assert.rejects(observeModule.observeReplay(observation(env, {
    eventId: EVENTS[1],
  })));
  assert.deepEqual(await fs.readFile(recordFile), before);
});

test('replay state deletion or corruption never changes authority', async () => {
  assert.ok(observeModule, 'production replay observer must exist');
  assert.ok(storeModule, 'production replay store must exist');
  const { home, env: replayEnv } = await environment();
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-replay-authority-'));
  temporary.push(project);
  const env = {
    ...replayEnv,
    NOOSPHERE_OWNER_SCOPE: 'phase5-replay-isolation',
  };
  const trusted = 'owner-approved authority bytes';
  const untrusted = `${trusted} altered`;
  const authority = createFormatV2Store({ env });
  const binding = await authority.createProjectBinding(project);
  await authority.commitTransaction({
    binding,
    slot: 'master-prompt',
    rawBytes: trusted,
    sourceOrigin: 'test:phase5-replay-isolation',
  });
  const request = rawBytes => ({
    projectRoot: project,
    slot: 'master-prompt',
    rawBytes,
    env,
  });
  assert.equal(await isSlotAuthoritative(request(trusted)), true);
  assert.equal(await isSlotAuthoritative(request(untrusted)), false);

  const observed = await observeModule.observeReplay(observation(env));
  const paths = storeModule.replayProjectPaths({
    env,
    projectIdentityDigest: PROJECT,
  });
  await fs.writeFile(
    path.join(paths.records, `${observed.record.replayIdentity.slice(7)}.json`),
    '{"corrupt":true}',
    { mode: 0o600 },
  );
  assert.equal(await isSlotAuthoritative(request(trusted)), true);
  assert.equal(await isSlotAuthoritative(request(untrusted)), false);

  await fs.rm(path.join(home, 'replay-v1'), { recursive: true, force: true });
  assert.equal(await isSlotAuthoritative(request(trusted)), true);
  assert.equal(await isSlotAuthoritative(request(untrusted)), false);
});
