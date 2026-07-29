import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { createFormatV2Store } from '../continuity/internal/trust-format-v2.js';

const presentation = await import(
  '../continuity/internal/replay/presentation.js'
).catch(() => null);
const temporary = [];
const NOW = '2026-07-29T19:00:00.000Z';

after(async () => {
  await Promise.all(temporary.map(directory =>
    fs.rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-ordinary-home-'));
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-ordinary-project-'));
  temporary.push(home, projectRoot);
  const context = {
    env: {
      NOOSPHERE_HOME: home,
      NOOSPHERE_OWNER_SCOPE: 'phase5-ordinary',
    },
    projectRoot,
  };
  await createFormatV2Store({ env: context.env })
    .createProjectBinding(projectRoot);
  return context;
}

test('structured ordinary recall preserves order, duplicates, quoting, and labels', async () => {
  assert.ok(presentation, 'production replay presentation module must exist');
  const context = await fixture();
  const response = {
    success: true,
    memories: [
      {
        action_id: 'a1',
        blob_id: 'b1',
        content: 'first duplicate',
        timestamp: '2026-07-29T18:59:00.000Z',
      },
      {
        action_id: 'a2',
        blob_id: 'b2',
        content: 'first duplicate',
        timestamp: '2026-06-01T00:00:00.000Z',
      },
      {
        action_id: 'a3',
        blob_id: 'b3',
        content: 'future evidence',
        timestamp: '2026-07-29T19:06:00.000Z',
      },
      null,
    ],
  };
  const result = await presentation.ingestOrdinaryRecall({
    ...context,
    response,
    now: () => new Date(NOW),
  });
  assert.deepEqual(
    result.items.map(item => item.replayClassification),
    ['NEW', 'SEEN', 'NEW', 'UNAVAILABLE'],
  );
  assert.deepEqual(
    result.items.map(item => item.freshness),
    ['CURRENT', 'STALE', 'TIME_UNVERIFIED', 'TIME_UNVERIFIED'],
  );
  assert.ok(result.rendered.indexOf('first duplicate') <
    result.rendered.indexOf('future evidence'));
  assert.equal(
    result.rendered.match(/> first duplicate/g)?.length,
    2,
  );
  assert.match(result.rendered, /Replay: SEEN/);
  assert.match(result.rendered, /Freshness: STALE/);
  assert.match(result.rendered, /> \(invalid recalled evidence\)/);
});

test('replay failure leaves ordinary content visible and labeled unavailable', async () => {
  assert.ok(presentation, 'production replay presentation module must exist');
  const context = await fixture();
  await presentation.ingestOrdinaryRecall({
    ...context,
    response: { memories: [{ content: 'visible despite replay failure' }] },
    now: () => new Date(NOW),
  });
  await fs.unlink(path.join(context.env.NOOSPHERE_HOME, 'replay-v1', 'machine.key'));
  const result = await presentation.ingestOrdinaryRecall({
    ...context,
    response: { memories: [{ content: 'visible despite replay failure' }] },
    now: () => new Date(NOW),
  });
  assert.equal(result.items[0].replayClassification, 'UNAVAILABLE');
  assert.match(result.rendered, /> visible despite replay failure/);
});
