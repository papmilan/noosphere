import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';

import { deriveReplayIdentity } from '../continuity/internal/replay/identity.js';

const stageModule = await import(
  '../continuity/internal/replay/restore-stage.js'
).catch(() => null);
const temporary = [];

after(async () => {
  await Promise.all(temporary.map(directory =>
    fs.rm(directory, { recursive: true, force: true })));
});

async function allFileText(root) {
  const values = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else values.push((await fs.readFile(file)).toString('utf8'));
    }
  }
  await visit(root);
  return values.join('\n');
}

test('replay and candidate artifacts persist zero cross-domain identity references', async () => {
  assert.ok(stageModule, 'production replay-aware restore staging must exist');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-identity-separation-home-'));
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-identity-separation-project-'));
  temporary.push(home, projectRoot);
  await fs.mkdir(path.join(projectRoot, '.noosphere'), { recursive: true });
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  output.isTTY = true;
  const content = 'identity-separated typed content';
  const result = await stageModule.stageReplayAwareRestoreCandidate({
    env: {
      NOOSPHERE_HOME: home,
      NOOSPHERE_OWNER_SCOPE: 'phase5-identity-separation',
    },
    projectRoot,
    slot: 'master-prompt',
    input,
    output,
    now: () => new Date('2026-07-29T18:45:00.000Z'),
    recallSource: async () => ({
      content: Buffer.from(content),
      metadata: {
        actionId: 'action-separated',
        actionType: 'master-prompt',
        agentId: null,
        timestamp: null,
        blobId: 'blob-separated',
      },
    }),
  });
  const replayIdentity = deriveReplayIdentity({
    projectIdentityDigest: result.projectIdentityDigest,
    slot: 'master-prompt',
    content,
  }).replayIdentity;
  const replayText = await allFileText(path.join(home, 'replay-v1'));
  const candidateText = await allFileText(path.join(home, 'trust-v2'));

  assert.equal(replayText.includes(result.candidate.candidateId), false);
  assert.equal(replayText.includes('candidatePath'), false);
  assert.equal(replayText.includes('candidateId'), false);
  assert.equal(candidateText.includes(replayIdentity), false);
  assert.equal(candidateText.includes('replayIdentity'), false);
  assert.equal(candidateText.includes('replay-v1'), false);
});
