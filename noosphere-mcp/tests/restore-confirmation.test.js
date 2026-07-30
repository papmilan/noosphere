import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, it } from 'node:test';

import {
  consumeCandidate,
  listRestoreCandidates,
  markApplyInProgress,
  readCandidateState,
  stageRestoreCandidate,
} from '../continuity/internal/restore/candidate-store.js';
import {
  confirmContext,
  confirmationPhrase,
  issueConfirmation,
  readConfirmation,
  spendContext,
} from '../continuity/internal/restore/confirmation-store.js';
import {
  AUTH_DOMAINS,
  sealRecord,
} from '../continuity/internal/authenticated-records.js';
import { createFormatV2Store } from '../continuity/internal/trust-format-v2.js';
import { canonicalize } from '../continuity/trust-store-internal.js';

const temporary = [];

after(async () => {
  await Promise.all(temporary.map(directory =>
    fs.rm(directory, { recursive: true, force: true })));
});

function ttyStreams() {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  output.isTTY = true;
  return { input, output };
}

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-confirm-home-'));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-confirm-project-'));
  temporary.push(home, project);
  await fs.mkdir(path.join(project, '.noosphere'), { recursive: true });
  const env = {
    NOOSPHERE_HOME: home,
    NOOSPHERE_OWNER_SCOPE: 'phase4c-owner',
  };
  const staged = await stageRestoreCandidate({
    projectRoot: project,
    slot: 'baseline',
    env,
    ...ttyStreams(),
    now: () => new Date('2026-07-27T00:00:00.000Z'),
    recall: async () => ({
      memories: [{
        action_type: 'project-baseline',
        content: '# Noosphere project baseline\n\ncandidate baseline\n',
      }],
    }),
  });
  return {
    candidate: staged.candidate,
    env,
    home,
    project,
  };
}

function issueInput(context, overrides = {}) {
  return {
    projectRoot: context.project,
    env: context.env,
    candidateId: context.candidate.candidateId,
    destination: { state: 'absent' },
    manifest: {
      state: 'pristine-unapproved',
      generation: { state: 'no-manifest' },
    },
    now: () => new Date('2026-07-27T00:01:00.000Z'),
    ...overrides,
  };
}

async function restoreProjectRoot(context) {
  const projects = path.join(context.home, 'trust-v2', 'projects');
  const [projectIdentity] = await fs.readdir(projects);
  return path.join(projects, projectIdentity, 'restore');
}

describe('SEC-05 Phase 4C — one-shot restore confirmation state', () => {
  it('keeps confirmation and candidate transitions independent and monotonic', async () => {
    const context = await fixture();
    const issued = await issueConfirmation(issueInput(context));
    const confirmed = await confirmContext({
      projectRoot: context.project,
      env: context.env,
      contextId: issued.contextId,
      phrase: confirmationPhrase(issued),
      now: () => new Date('2026-07-27T00:02:00.000Z'),
    });
    const transactionId = '11111111-1111-4111-8111-111111111111';
    const spent = await spendContext({
      projectRoot: context.project,
      env: context.env,
      contextId: confirmed.contextId,
      transactionId,
      now: () => new Date('2026-07-27T00:03:00.000Z'),
    });
    const inProgress = await markApplyInProgress({
      projectRoot: context.project,
      env: context.env,
      candidateId: context.candidate.candidateId,
      contextId: spent.contextId,
      transactionId,
      now: () => new Date('2026-07-27T00:04:00.000Z'),
    });
    const consumed = await consumeCandidate({
      projectRoot: context.project,
      env: context.env,
      candidateId: context.candidate.candidateId,
      transactionId: inProgress.transactionId,
      outcome: 'failed',
      now: () => new Date('2026-07-27T00:05:00.000Z'),
    });

    assert.equal(spent.state, 'spent');
    assert.equal(inProgress.state, 'apply-in-progress');
    assert.equal(consumed.state, 'consumed');
    assert.deepEqual(await listRestoreCandidates({
      projectRoot: context.project,
      env: context.env,
      now: () => new Date('2026-07-27T00:06:00.000Z'),
    }), []);
    await assert.rejects(
      confirmContext({
        projectRoot: context.project,
        env: context.env,
        contextId: spent.contextId,
        phrase: confirmationPhrase(issued),
      }),
      error => error.code === 'ERR_RESTORE_CONFIRMATION_SPENT',
    );
    await assert.rejects(
      markApplyInProgress({
        projectRoot: context.project,
        env: context.env,
        candidateId: context.candidate.candidateId,
        contextId: spent.contextId,
        transactionId,
      }),
      error => error.code === 'ERR_RESTORE_CANDIDATE_CONSUMED',
    );
  });

  it('binds destination absence without inventing a hash', async () => {
    const fixtureContext = await fixture();
    const context = await issueConfirmation(issueInput(fixtureContext));
    assert.deepEqual(context.destination, { state: 'absent' });
    assert.equal('hash' in context.destination, false);
  });

  it('spends the issued context after one wrong phrase and refuses replay', async () => {
    const context = await fixture();
    const issued = await issueConfirmation(issueInput(context));
    await assert.rejects(
      confirmContext({
        projectRoot: context.project,
        env: context.env,
        contextId: issued.contextId,
        phrase: `${confirmationPhrase(issued)} `,
        now: () => new Date('2026-07-27T00:02:00.000Z'),
      }),
      error => error.code === 'restore-declined',
    );
    assert.equal((await readConfirmation({
      projectRoot: context.project,
      env: context.env,
      contextId: issued.contextId,
    })).state, 'spent');
    await assert.rejects(
      confirmContext({
        projectRoot: context.project,
        env: context.env,
        contextId: issued.contextId,
        phrase: confirmationPhrase(issued),
      }),
      error => error.code === 'ERR_RESTORE_CONFIRMATION_SPENT',
    );
  });

  it('spends expired or changed contexts without changing candidate state', async () => {
    for (const change of [
      { destination: { state: 'present', rawHash: 'a'.repeat(64) } },
      {
        manifest: {
          state: 'approved',
          generation: { state: 'present', value: 1 },
        },
      },
      { candidateId: `${'a'.repeat(51)}q` },
      { candidatePayloadHash: 'd'.repeat(64) },
      { slot: 'instructions' },
      { projectIdentityDigest: `sha256:${'b'.repeat(64)}` },
      { machineKeyIdentity: 'c'.repeat(64) },
    ]) {
      const context = await fixture();
      const issued = await issueConfirmation(issueInput(context));
      await assert.rejects(
        confirmContext({
          projectRoot: context.project,
          env: context.env,
          contextId: issued.contextId,
          phrase: confirmationPhrase(issued),
          observed: {
            candidateId: issued.candidateId,
            candidatePayloadHash: issued.candidatePayloadHash,
            slot: issued.slot,
            destination: issued.destination,
            manifest: issued.manifest,
            projectIdentityDigest: issued.projectIdentityDigest,
            machineKeyIdentity: issued.machineKeyIdentity,
            ...change,
          },
          now: () => new Date('2026-07-27T00:02:00.000Z'),
        }),
        error => error.code === 'ERR_RESTORE_CONFIRMATION_CHANGED',
      );
      assert.equal((await readCandidateState({
        projectRoot: context.project,
        env: context.env,
        candidateId: context.candidate.candidateId,
      })).state, 'active');
    }

    const expiredContext = await fixture();
    const issued = await issueConfirmation(issueInput(expiredContext));
    await assert.rejects(
      confirmContext({
        projectRoot: expiredContext.project,
        env: expiredContext.env,
        contextId: issued.contextId,
        phrase: confirmationPhrase(issued),
        now: () => new Date('2026-07-27T00:12:00.001Z'),
      }),
      error => error.code === 'ERR_RESTORE_CONFIRMATION_EXPIRED',
    );
    assert.equal((await readConfirmation({
      projectRoot: expiredContext.project,
      env: expiredContext.env,
      contextId: issued.contextId,
    })).state, 'spent');
  });

  it('rejects authenticated current-state rollback and duplicate sequences', async () => {
    const rollback = await fixture();
    const issued = await issueConfirmation(issueInput(rollback));
    const restoreRoot = await restoreProjectRoot(rollback);
    const contextRoot = path.join(
      restoreRoot,
      'confirmations',
      issued.contextId,
    );
    const currentFile = path.join(contextRoot, 'state', 'current.json');
    const issuedCurrent = await fs.readFile(currentFile);
    await confirmContext({
      projectRoot: rollback.project,
      env: rollback.env,
      contextId: issued.contextId,
      phrase: confirmationPhrase(issued),
      now: () => new Date('2026-07-27T00:02:00.000Z'),
    });
    const eventsBefore = await fs.readdir(path.join(contextRoot, 'state', 'events'));
    await fs.writeFile(currentFile, issuedCurrent);
    await assert.rejects(
      readConfirmation({
        projectRoot: rollback.project,
        env: rollback.env,
        contextId: issued.contextId,
      }),
      error => error.code === 'ERR_RESTORE_STATE_INVALID',
    );
    assert.deepEqual(
      await fs.readdir(path.join(contextRoot, 'state', 'events')),
      eventsBefore,
    );

    const forked = await fixture();
    const forkedIssued = await issueConfirmation(issueInput(forked));
    const forkedRoot = path.join(
      await restoreProjectRoot(forked),
      'confirmations',
      forkedIssued.contextId,
    );
    const eventsDir = path.join(forkedRoot, 'state', 'events');
    const [eventName] = await fs.readdir(eventsDir);
    const original = JSON.parse(
      await fs.readFile(path.join(eventsDir, eventName), 'utf8'),
    );
    const { mac: ignoredMac, ...fields } = original;
    const duplicateId = randomUUID();
    const store = createFormatV2Store({ env: forked.env });
    const duplicate = sealRecord(
      await store.ensureMachineKey(),
      AUTH_DOMAINS.restoreConfirmation,
      { ...fields, eventId: duplicateId },
    );
    await fs.writeFile(
      path.join(eventsDir, `1-${duplicateId}.json`),
      canonicalize(duplicate),
    );
    await assert.rejects(
      readConfirmation({
        projectRoot: forked.project,
        env: forked.env,
        contextId: forkedIssued.contextId,
      }),
      error => error.code === 'ERR_RESTORE_STATE_INVALID',
    );
  });

  it('does not let project substitution locate or spend another project context', async () => {
    const context = await fixture();
    const issued = await issueConfirmation(issueInput(context));
    const otherProject = await fs.mkdtemp(
      path.join(os.tmpdir(), 'noosphere-confirm-other-project-'),
    );
    temporary.push(otherProject);
    const store = createFormatV2Store({ env: context.env });
    await store.createProjectBinding(otherProject);

    await assert.rejects(
      confirmContext({
        projectRoot: otherProject,
        env: context.env,
        contextId: issued.contextId,
        phrase: confirmationPhrase(issued),
      }),
      error => error.code === 'ERR_RESTORE_CONFIRMATION_MISSING',
    );
    assert.equal((await readConfirmation({
      projectRoot: context.project,
      env: context.env,
      contextId: issued.contextId,
    })).state, 'issued');
  });

  it('does not reveal active candidate state after current-reference rollback', async () => {
    const context = await fixture();
    const issued = await issueConfirmation(issueInput(context));
    const confirmed = await confirmContext({
      projectRoot: context.project,
      env: context.env,
      contextId: issued.contextId,
      phrase: confirmationPhrase(issued),
      now: () => new Date('2026-07-27T00:02:00.000Z'),
    });
    const transactionId = '22222222-2222-4222-8222-222222222222';
    await spendContext({
      projectRoot: context.project,
      env: context.env,
      contextId: confirmed.contextId,
      transactionId,
      now: () => new Date('2026-07-27T00:03:00.000Z'),
    });
    const restoreRoot = await restoreProjectRoot(context);
    const candidateRoot = path.join(
      restoreRoot,
      'candidates',
      context.candidate.candidateId,
    );
    const currentFile = path.join(candidateRoot, 'state', 'current.json');
    const activeCurrent = await fs.readFile(currentFile);
    await markApplyInProgress({
      projectRoot: context.project,
      env: context.env,
      candidateId: context.candidate.candidateId,
      contextId: issued.contextId,
      transactionId,
      now: () => new Date('2026-07-27T00:04:00.000Z'),
    });
    await fs.writeFile(currentFile, activeCurrent);
    await assert.rejects(
      readCandidateState({
        projectRoot: context.project,
        env: context.env,
        candidateId: context.candidate.candidateId,
      }),
      error => error.code === 'ERR_RESTORE_STATE_INVALID',
    );
  });

  it('cannot bind one spent confirmation transaction to another candidate', async () => {
    const context = await fixture();
    const second = await stageRestoreCandidate({
      projectRoot: context.project,
      slot: 'instructions',
      env: context.env,
      ...ttyStreams(),
      recall: async () => ({
        memories: [{
          action_type: 'project-instructions',
          content: 'second candidate',
        }],
      }),
    });
    const issued = await issueConfirmation(issueInput(context));
    const confirmed = await confirmContext({
      projectRoot: context.project,
      env: context.env,
      contextId: issued.contextId,
      phrase: confirmationPhrase(issued),
      now: () => new Date('2026-07-27T00:02:00.000Z'),
    });
    const transactionId = '33333333-3333-4333-8333-333333333333';
    await spendContext({
      projectRoot: context.project,
      env: context.env,
      contextId: confirmed.contextId,
      transactionId,
      now: () => new Date('2026-07-27T00:03:00.000Z'),
    });

    await assert.rejects(
      markApplyInProgress({
        projectRoot: context.project,
        env: context.env,
        candidateId: second.candidate.candidateId,
        contextId: issued.contextId,
        transactionId,
      }),
      error => error.code === 'ERR_RESTORE_CANDIDATE_TRANSITION',
    );
    assert.equal((await readCandidateState({
      projectRoot: context.project,
      env: context.env,
      candidateId: second.candidate.candidateId,
    })).state, 'active');
  });
});
