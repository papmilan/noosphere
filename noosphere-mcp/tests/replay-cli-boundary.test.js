import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { observeReplay } from '../continuity/internal/replay/observe.js';
import { createFormatV2Store } from '../continuity/internal/trust-format-v2.js';

// fileURLToPath, not `new URL(...).pathname`: on Windows the URL path is
// `/D:/...`, which path.resolve turns into `D:\D:\...`.
const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const cliModule = await import(
  '../continuity/internal/replay/cli.js'
).catch(() => null);
const readerModule = await import(
  '../continuity/internal/replay/reader.js'
).catch(() => null);
const temporary = [];

after(async () => {
  await Promise.all(temporary.map(directory =>
    fs.rm(directory, { recursive: true, force: true })));
});

async function snapshot(root) {
  const entries = [];
  async function visit(directory, relative = '') {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const name = path.join(relative, entry.name);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        entries.push([`${name}/`, null]);
        await visit(absolute, name);
      } else {
        entries.push([name, (await fs.readFile(absolute)).toString('hex')]);
      }
    }
  }
  await visit(root);
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

test('replay CLI grammar is exactly status and bounded list', () => {
  assert.ok(cliModule, 'production replay CLI parser must exist');
  assert.deepEqual(cliModule.parseReplayArgs(['status']), { verb: 'status' });
  assert.deepEqual(
    cliModule.parseReplayArgs([
      'list',
      '--slot',
      'ordinary',
      '--limit',
      '25',
    ]),
    { verb: 'list', slot: 'ordinary', limit: 25 },
  );
  for (const args of [
    [],
    ['status', '--json'],
    ['list', '--limit', '0'],
    ['list', '--limit', '101'],
    ['list', '--slot', 'unknown'],
    ['clear'],
    ['reset'],
    ['reinitialize'],
    ['rotate-key'],
    ['repair'],
    ['recover'],
    ['compact'],
    ['import'],
    ['export'],
    ['add'],
    ['remove'],
  ]) {
    assert.throws(() => cliModule.parseReplayArgs(args));
  }
});

test('status and list authenticate incomplete state without changing one byte', async () => {
  assert.ok(readerModule, 'production replay reader must exist');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-reader-home-'));
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-reader-project-'));
  temporary.push(home, projectRoot);
  const env = {
    NOOSPHERE_HOME: home,
    NOOSPHERE_OWNER_SCOPE: 'phase5-reader',
  };
  const store = createFormatV2Store({ env });
  await store.createProjectBinding(projectRoot);
  const projectIdentityDigest =
    await store.canonicalProjectIdentityDigest(projectRoot);
  const common = {
    env,
    projectIdentityDigest,
    slot: 'ordinary',
    recallIdentity: `sha256:${'5'.repeat(64)}`,
    origin: 'walrus-recall',
    duplicateCandidate: false,
  };
  await observeReplay({
    ...common,
    content: 'older visible record',
    observedAt: '2026-07-29T20:00:00.000Z',
    eventId: '55555555-5555-4555-8555-555555555555',
  });
  await observeReplay({
    ...common,
    content: 'newer visible record',
    observedAt: '2026-07-29T20:01:00.000Z',
    eventId: '66666666-6666-4666-8666-666666666666',
  });
  await assert.rejects(observeReplay({
    ...common,
    content: 'stranded prepared record',
    observedAt: '2026-07-29T20:02:00.000Z',
    eventId: '77777777-7777-4777-8777-777777777777',
    onStep(state) {
      if (state === 'prepared') throw new Error('strand journal');
    },
  }));
  const replayRoot = path.join(home, 'replay-v1');
  const before = await snapshot(replayRoot);

  const status = await readerModule.readReplayStatus({
    env,
    projectRoot,
  });
  const listed = await readerModule.listReplayEvidence({
    env,
    projectRoot,
    slot: 'ordinary',
    limit: 100,
  });

  assert.equal(status.health, 'RECOVERY_REQUIRED');
  assert.equal(status.projectIdentityDigest, projectIdentityDigest);
  assert.equal(status.recordCount, 2);
  assert.equal(status.maximumLiveRecords, 4096);
  assert.equal(status.maximumRecordAgeDays, 90);
  assert.equal(status.incompleteJournalCount, 1);
  assert.deepEqual(
    listed.map(item => item.lastSeen.observedAt),
    ['2026-07-29T20:01:00.000Z', '2026-07-29T20:00:00.000Z'],
  );
  const expectedFields = [
    'firstSeen',
    'lastClassification',
    'lastSeen',
    'projectIdentityDigest',
    'replayCount',
    'replayIdentity',
    'slot',
    'state',
  ];
  assert.ok(listed.every(item =>
    assert.deepEqual(Object.keys(item).sort(), expectedFields) === undefined));
  const cli = spawnSync(
    process.execPath,
    ['continuity/index.js', 'replay', 'status', '--path', projectRoot],
    {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, ...env },
      encoding: 'utf8',
    },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).health, 'RECOVERY_REQUIRED');
  assert.equal(await snapshot(replayRoot), before);
});
