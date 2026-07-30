import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { refreshContext } from '../continuity/index.js';
import { deriveReplayIdentity } from '../continuity/internal/replay/identity.js';
import { loadReplayKey } from '../continuity/internal/replay/key.js';
import {
  readReplayRecord,
} from '../continuity/internal/replay/store.js';
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

test('production context refresh records every recalled follow-up without self-contention', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-context-home-'));
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-context-project-'));
  temporary.push(home, projectRoot);
  const env = {
    NOOSPHERE_HOME: home,
    NOOSPHERE_OWNER_SCOPE: 'phase5-context-many',
  };
  await fs.mkdir(path.join(projectRoot, '.noosphere'), { recursive: true });
  const store = createFormatV2Store({ env });
  await store.createProjectBinding(projectRoot);
  const memories = Array.from({ length: 8 }, (_, index) => ({
    action_id: `typed-followup-${index}`,
    action_type: 'user-followup',
    content: `recalled follow-up ${index}`,
    timestamp: '2026-07-29T18:00:00.000Z',
  }));
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'POST' && url.pathname.endsWith('/recall')) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        memories: body.action_type === 'user-followup' ? memories : [],
      }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('structured context shell\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    await fs.writeFile(
      path.join(projectRoot, '.noosphere', 'config.json'),
      JSON.stringify({
        project_id: 'phase5-context-many',
        relayer_url: `http://127.0.0.1:${port}`,
        privacy: {},
      }),
    );

    const rendered = await refreshContext(projectRoot, {
      env,
      now: () => new Date('2026-07-29T19:00:00.000Z'),
    });

    assert.equal((rendered.match(/Replay: NEW/g) ?? []).length, memories.length);
    assert.doesNotMatch(rendered, /Replay: UNAVAILABLE/);
    const key = await loadReplayKey({ env });
    const projectIdentityDigest =
      await store.canonicalProjectIdentityDigest(projectRoot);
    for (const memory of memories) {
      const { replayIdentity } = deriveReplayIdentity({
        projectIdentityDigest,
        slot: 'followups',
        content: memory.content,
      });
      const record = await readReplayRecord({
        env,
        key,
        projectIdentityDigest,
        replayIdentity,
      });
      assert.equal(record?.replayCount, 1, memory.action_id);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
