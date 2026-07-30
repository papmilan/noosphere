import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { deriveReplayIdentity } from '../continuity/internal/replay/identity.js';
import { loadReplayKey } from '../continuity/internal/replay/key.js';
import {
  readReplayRecord,
  replayProjectPaths,
} from '../continuity/internal/replay/store.js';
import { createFormatV2Store } from '../continuity/internal/trust-format-v2.js';
import { assertForciblyTerminated } from './helpers/child-crash.js';

const temporary = [];
const STRANDED_CONTENT = 'stranded before production entry';
const STRANDED_EVENT = '44444444-4444-4444-8444-444444444444';

after(async () => {
  await Promise.all(temporary.map(directory =>
    fs.rm(directory, { recursive: true, force: true })));
});

async function fixture(mode) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-entry-home-'));
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-entry-project-'));
  temporary.push(home, projectRoot);
  await fs.mkdir(path.join(projectRoot, '.noosphere'), { recursive: true });
  const env = {
    NOOSPHERE_HOME: home,
    NOOSPHERE_OWNER_SCOPE: `phase5-entry-${mode}`,
  };
  const store = createFormatV2Store({ env });
  await store.createProjectBinding(projectRoot);
  const projectIdentityDigest =
    await store.canonicalProjectIdentityDigest(projectRoot);
  return { home, projectRoot, env, projectIdentityDigest };
}

function crash(context) {
  const child = spawnSync(
    process.execPath,
    ['tests/helpers/replay-crash-child.mjs'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        REPLAY_CRASH_HOME: context.home,
        REPLAY_CRASH_AT: 'prepared',
        REPLAY_PROJECT: context.projectIdentityDigest,
        REPLAY_CONTENT: STRANDED_CONTENT,
        REPLAY_RECALL: `sha256:${'4'.repeat(64)}`,
        REPLAY_OBSERVED_AT: '2026-07-29T19:00:00.000Z',
        REPLAY_EVENT_ID: STRANDED_EVENT,
      },
      encoding: 'utf8',
    },
  );
  assertForciblyTerminated(child, { context: child.stderr });
}

async function performOwnerLockIntervention(context) {
  const paths = replayProjectPaths({
    env: context.env,
    projectIdentityDigest: context.projectIdentityDigest,
  });
  for (const name of await fs.readdir(paths.locks)) {
    await fs.unlink(path.join(paths.locks, name));
  }
  await fs.unlink(path.join(paths.project, 'ledger.lock'));
}

async function strandedRecord(context) {
  const key = await loadReplayKey({ env: context.env });
  const replayIdentity = deriveReplayIdentity({
    projectIdentityDigest: context.projectIdentityDigest,
    slot: 'ordinary',
    content: STRANDED_CONTENT,
  }).replayIdentity;
  return readReplayRecord({
    env: context.env,
    key,
    projectIdentityDigest: context.projectIdentityDigest,
    replayIdentity,
  });
}

async function assertRecovered(context) {
  const record = await strandedRecord(context);
  assert.equal(record.replayCount, 1);
  assert.equal(record.firstSeen.eventId, STRANDED_EVENT);
}

async function runEntry(context, mode) {
  const result = await new Promise(resolve => {
    const child = spawn(
      process.execPath,
      ['tests/helpers/replay-production-entry-child.mjs'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          REPLAY_ENTRY_MODE: mode,
          REPLAY_ENTRY_HOME: context.home,
          REPLAY_ENTRY_SCOPE: context.env.NOOSPHERE_OWNER_SCOPE,
          REPLAY_ENTRY_PROJECT_ROOT: context.projectRoot,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('close', (status, signal) => resolve({
      status,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
  return result;
}

for (const mode of ['restore-stage', 'ordinary']) {
  test(`${mode} refuses a stranded crash lock, then recovers after owner intervention`, async () => {
    const context = await fixture(mode);
    crash(context);
    const refused = await runEntry(context, mode);
    if (mode === 'restore-stage') {
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /replay-lock-busy/);
    } else {
      assert.equal(refused.status, 0, refused.stderr || refused.signal);
    }
    assert.equal(await strandedRecord(context), null);

    await performOwnerLockIntervention(context);
    const recovered = await runEntry(context, mode);
    assert.equal(recovered.status, 0, recovered.stderr || recovered.signal);
    await assertRecovered(context);
  });
}

test('typed context refresh refuses a crash lock, then recovers after owner intervention', async () => {
  const context = await fixture('context-refresh');
  await fs.writeFile(
    path.join(context.projectRoot, '.noosphere', 'master-prompt.md'),
    'local master',
  );
  await fs.writeFile(
    path.join(context.projectRoot, '.noosphere', 'followups.jsonl'),
    '{"content":"local followup"}\n',
  );
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'POST' && url.pathname.endsWith('/recall')) {
      for await (const chunk of request) void chunk;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        memories: [{
          action_id: 'context-entry',
          action_type: 'project-baseline',
          content: 'production typed context entry',
          timestamp: '2026-07-29T19:00:00.000Z',
        }],
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
      path.join(context.projectRoot, '.noosphere', 'config.json'),
      JSON.stringify({
        project_id: 'phase5-context-entry',
        relayer_url: `http://127.0.0.1:${port}`,
        privacy: {},
      }),
    );
    crash(context);
    const refused = await runEntry(context, 'context-refresh');
    assert.equal(refused.status, 0, refused.stderr || refused.signal);
    assert.equal(await strandedRecord(context), null);

    await performOwnerLockIntervention(context);
    const recovered = await runEntry(context, 'context-refresh');
    assert.equal(recovered.status, 0, recovered.stderr || recovered.signal);
    await assertRecovered(context);
    const rendered = await fs.readFile(
      path.join(context.projectRoot, '.noosphere', 'context.md'),
      'utf8',
    );
    assert.match(rendered, /Replay: NEW/);
    assert.match(rendered, /Freshness: CURRENT/);
    assert.match(rendered, /> production typed context entry/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
