import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';

import { AUTH_DOMAINS } from '../continuity/internal/authenticated-records.js';
import { stageRestoreCandidate } from '../continuity/internal/restore/candidate-store.js';
import { commitConsumedMarker } from '../continuity/internal/restore/receipt-store.js';
import {
  CANDIDATE_TRANSITIONS,
  transitionStateMachine,
} from '../continuity/internal/restore/state-machine.js';
import { createFormatV2Store } from '../continuity/internal/trust-format-v2.js';

const stageModule = await import(
  '../continuity/internal/replay/restore-stage.js'
).catch(() => null);

const temporary = [];

after(async () => {
  await Promise.all(temporary.map(directory =>
    fs.rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-replay-stage-home-'));
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-replay-stage-project-'));
  temporary.push(home, projectRoot);
  await fs.mkdir(path.join(projectRoot, '.noosphere'), { recursive: true });
  return {
    env: {
      NOOSPHERE_HOME: home,
      NOOSPHERE_OWNER_SCOPE: 'phase5-restore-suppression',
    },
    home,
    projectRoot,
  };
}

function tty() {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  output.isTTY = true;
  return { input, output };
}

function source(content, actionId = 'action-1') {
  return Object.freeze({
    content: Buffer.from(content),
    metadata: Object.freeze({
      actionId,
      actionType: 'master-prompt',
      agentId: 'remote-agent',
      timestamp: '2026-07-29T18:30:00.000Z',
      blobId: 'blob-1',
    }),
  });
}

test('an active matching candidate suppresses duplicate staging', async () => {
  assert.ok(stageModule, 'production replay-aware restore staging must exist');
  const context = await fixture();
  const first = await stageModule.stageReplayAwareRestoreCandidate({
    ...context,
    slot: 'master-prompt',
    recallSource: async () => source('same typed content'),
    now: () => new Date('2026-07-29T18:30:00.000Z'),
    ...tty(),
  });
  const second = await stageModule.stageReplayAwareRestoreCandidate({
    ...context,
    slot: 'master-prompt',
    recallSource: async () => source('same typed content', 'action-2'),
    now: () => new Date('2026-07-29T18:31:00.000Z'),
    ...tty(),
  });

  assert.equal(first.status, 'staged');
  assert.equal(first.replayClassification, 'NEW');
  assert.equal(second.status, 'suppressed');
  assert.equal(second.replayClassification, 'SUPPRESSED');
  assert.equal(second.candidate.candidateId, first.candidate.candidateId);
  assert.equal(second.candidate.trustLabel, 'untrusted');
});

test('different canonical content and slots stage independent random candidates', async () => {
  assert.ok(stageModule, 'production replay-aware restore staging must exist');
  const context = await fixture();
  const first = await stageModule.stageReplayAwareRestoreCandidate({
    ...context,
    slot: 'master-prompt',
    recallSource: async () => source('first content'),
    now: () => new Date('2026-07-29T18:30:00.000Z'),
    ...tty(),
  });
  const second = await stageModule.stageReplayAwareRestoreCandidate({
    ...context,
    slot: 'master-prompt',
    recallSource: async () => source('second content'),
    now: () => new Date('2026-07-29T18:31:00.000Z'),
    ...tty(),
  });
  const third = await stageModule.stageReplayAwareRestoreCandidate({
    ...context,
    slot: 'baseline',
    recallSource: async () => ({
      ...source('first content'),
      metadata: {
        ...source('first content').metadata,
        actionType: 'project-baseline',
      },
    }),
    now: () => new Date('2026-07-29T18:32:00.000Z'),
    ...tty(),
  });
  const ids = new Set([
    first.candidate.candidateId,
    second.candidate.candidateId,
    third.candidate.candidateId,
  ]);
  assert.equal(ids.size, 3);
  assert.ok([...ids].every(id => /^[a-z2-7]{52}$/.test(id)));
});

test('apply-in-progress refuses after observation; consumed returns bounded suppression', async () => {
  assert.ok(stageModule, 'production replay-aware restore staging must exist');
  const context = await fixture();
  const common = {
    ...context,
    slot: 'master-prompt',
    recallSource: async () => source('stateful duplicate content'),
    ...tty(),
  };
  const first = await stageModule.stageReplayAwareRestoreCandidate({
    ...common,
    now: () => new Date('2026-07-29T18:30:00.000Z'),
  });
  const store = createFormatV2Store({ env: context.env });
  const binding = await store.readProjectBinding(context.projectRoot);
  const key = await store.ensureMachineKey();
  const candidateRoot = store.pathFor(
    binding,
    path.join('restore', 'candidates', first.candidate.candidateId),
  );
  const expected = {
    domain: AUTH_DOMAINS.restoreCandidate,
    entityKind: 'candidate',
    entityId: first.candidate.candidateId,
    projectIdentityDigest: first.projectIdentityDigest,
    keyId: binding.keyId,
  };
  const contextId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const transactionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await transitionStateMachine({
    root: candidateRoot,
    key,
    expected,
    transitions: CANDIDATE_TRANSITIONS,
    to: 'apply-in-progress',
    code: 'test-transition',
    metadata: { contextId, transactionId },
    now: new Date('2026-07-29T18:31:00.000Z'),
  });
  await assert.rejects(
    stageModule.stageReplayAwareRestoreCandidate({
      ...common,
      now: () => new Date('2026-07-29T18:32:00.000Z'),
    }),
    error => error.code === 'restore-candidate-match-in-progress',
  );
  await transitionStateMachine({
    root: candidateRoot,
    key,
    expected,
    transitions: CANDIDATE_TRANSITIONS,
    to: 'consumed',
    code: 'test-transition',
    metadata: { contextId, transactionId, outcome: 'failed' },
    now: new Date('2026-07-29T18:33:00.000Z'),
  });
  await commitConsumedMarker({
    projectRoot: context.projectRoot,
    env: context.env,
    transactionId,
    contextId,
    candidateId: first.candidate.candidateId,
    candidatePayloadHash: first.candidate.payloadHash,
    slot: 'master-prompt',
    outcome: 'failed-before-replacement',
    now: () => new Date('2026-07-29T18:33:00.000Z'),
  });
  const consumed = await stageModule.stageReplayAwareRestoreCandidate({
    ...common,
    now: () => new Date('2026-07-29T18:34:00.000Z'),
  });
  assert.deepEqual(consumed, {
    status: 'already-consumed',
    replayClassification: 'SUPPRESSED',
    projectIdentityDigest: first.projectIdentityDigest,
    candidateId: first.candidate.candidateId,
    outcome: 'failed-before-replacement',
  });
});

test('concurrent identical staging creates at most one random candidate', async () => {
  assert.ok(stageModule, 'production replay-aware restore staging must exist');
  const context = await fixture();
  const attempts = await Promise.allSettled(
    Array.from({ length: 8 }, (_, index) =>
      stageModule.stageReplayAwareRestoreCandidate({
        ...context,
        slot: 'master-prompt',
        recallSource: async () => source('concurrent duplicate', `action-${index}`),
        now: () => new Date('2026-07-29T18:40:00.000Z'),
        ...tty(),
      })),
  );
  assert.equal(
    attempts.filter(item => item.status === 'fulfilled' &&
      item.value.status === 'staged').length,
    1,
  );
  const projectsRoot = path.join(context.home, 'trust-v2', 'projects');
  const [project] = await fs.readdir(projectsRoot);
  const candidates = await fs.readdir(path.join(
    projectsRoot,
    project,
    'restore',
    'candidates',
  ));
  assert.equal(candidates.length, 1);
});

test('malformed or multiple matching candidate artifacts fail closed', async () => {
  assert.ok(stageModule, 'production replay-aware restore staging must exist');
  const malformed = await fixture();
  const first = await stageModule.stageReplayAwareRestoreCandidate({
    ...malformed,
    slot: 'master-prompt',
    recallSource: async () => source('malformed duplicate'),
    now: () => new Date('2026-07-29T18:50:00.000Z'),
    ...tty(),
  });
  const malformedProjects = path.join(malformed.home, 'trust-v2', 'projects');
  const [malformedProject] = await fs.readdir(malformedProjects);
  await fs.writeFile(path.join(
    malformedProjects,
    malformedProject,
    'restore',
    'candidates',
    first.candidate.candidateId,
    'envelope.json',
  ), '{"corrupt":true}');
  await assert.rejects(
    stageModule.stageReplayAwareRestoreCandidate({
      ...malformed,
      slot: 'master-prompt',
      recallSource: async () => source('malformed duplicate'),
      now: () => new Date('2026-07-29T18:51:00.000Z'),
      ...tty(),
    }),
  );

  const conflict = await fixture();
  const candidateSource = source('conflicting duplicate');
  await stageRestoreCandidate({
    ...conflict,
    slot: 'master-prompt',
    recallSource: async () => candidateSource,
    now: () => new Date('2026-07-29T18:52:00.000Z'),
    ...tty(),
  });
  await stageRestoreCandidate({
    ...conflict,
    slot: 'master-prompt',
    recallSource: async () => candidateSource,
    now: () => new Date('2026-07-29T18:53:00.000Z'),
    ...tty(),
  });
  await assert.rejects(
    stageModule.stageReplayAwareRestoreCandidate({
      ...conflict,
      slot: 'master-prompt',
      recallSource: async () => candidateSource,
      now: () => new Date('2026-07-29T18:54:00.000Z'),
      ...tty(),
    }),
    error => error.code === 'restore-candidate-match-conflict',
  );
});
