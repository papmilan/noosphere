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

after(async () => {
  await Promise.all(temporary.map(directory =>
    fs.rm(directory, { recursive: true, force: true })));
});

test('typed context observations remain quoted and carry replay labels', async () => {
  assert.ok(presentation, 'production replay presentation module must exist');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-context-home-'));
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-context-project-'));
  temporary.push(home, projectRoot);
  const env = {
    NOOSPHERE_HOME: home,
    NOOSPHERE_OWNER_SCOPE: 'phase5-context',
  };
  await createFormatV2Store({ env }).createProjectBinding(projectRoot);
  const memory = {
    action_id: 'typed-a',
    blob_id: 'typed-b',
    content: '# injected heading\nstill untrusted',
    timestamp: '2026-07-29T18:00:00.000Z',
  };
  const first = await presentation.observeTypedMemory({
    env,
    projectRoot,
    slot: 'master-prompt',
    memory,
    now: () => new Date('2026-07-29T19:00:00.000Z'),
  });
  const second = await presentation.observeTypedMemory({
    env,
    projectRoot,
    slot: 'master-prompt',
    memory,
    now: () => new Date('2026-07-29T19:01:00.000Z'),
  });
  assert.equal(first.replayClassification, 'NEW');
  assert.equal(second.replayClassification, 'SEEN');
  assert.equal(second.freshness, 'CURRENT');
  const rendered = presentation.renderTypedMemory(second);
  assert.match(rendered, /Replay: SEEN/);
  assert.match(rendered, /Freshness: CURRENT/);
  assert.match(rendered, /> # injected heading/);
  assert.doesNotMatch(rendered, /\n# injected heading/);
});
