import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { applyRestoreCandidate } from '../continuity/internal/restore/apply-service.js';
import { readCandidateState, stageRestoreCandidate } from '../continuity/internal/restore/candidate-store.js';
import { readApplyJournal } from '../continuity/internal/restore/apply-journal.js';
import { classifyLockLiveness, recoverRestoreTransactions } from '../continuity/internal/restore/recovery.js';
import { classifyRestoreReceipt } from '../continuity/internal/restore/receipt-store.js';
import { createFormatV2Store } from '../continuity/internal/trust-format-v2.js';

const CHILD = fileURLToPath(
  new URL('./helpers/restore-crash-child.mjs', import.meta.url),
);

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
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-recovery-home-'));
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-recovery-project-'));
  temporary.push(home, projectRoot);
  await fs.mkdir(path.join(projectRoot, '.noosphere'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, '.noosphere', 'baseline.md'), 'before');
  const env = {
    NOOSPHERE_HOME: home,
    NOOSPHERE_OWNER_SCOPE: 'phase4c-owner',
  };
  const content = '# Noosphere project baseline\n\nafter\n';
  const staged = await stageRestoreCandidate({
    projectRoot,
    slot: 'baseline',
    env,
    ...ttyStreams(),
    recall: async () => ({
      memories: [{ action_type: 'project-baseline', content }],
    }),
  });
  return {
    projectRoot,
    env,
    content,
    candidateId: staged.candidate.candidateId,
    destination: path.join(projectRoot, '.noosphere', 'baseline.md'),
  };
}

function crashAt(state) {
  return async observed => {
    if (observed === state) {
      const error = new Error(`simulated crash after ${state}`);
      error.simulatedCrash = true;
      throw error;
    }
  };
}

describe('SEC-05 Phase 4C — authenticated restore recovery', () => {
  for (const state of [
    'prepared',
    'temporary-written',
    'destination-replaced',
    'receipt-committed',
    'consumed-marker-committed',
  ]) {
    it(`recovers idempotently after ${state} without repeating replacement`, async () => {
      const context = await fixture();
      let replacements = 0;
      await assert.rejects(
        applyRestoreCandidate({
          projectRoot: context.projectRoot,
          env: context.env,
          candidateId: context.candidateId,
          confirm: () => true,
          afterJournalState: crashAt(state),
          onDestinationReplaced: () => {
            replacements += 1;
          },
        }),
        error => error.simulatedCrash === true,
      );
      await recoverRestoreTransactions({
        projectRoot: context.projectRoot,
        env: context.env,
      });
      await recoverRestoreTransactions({
        projectRoot: context.projectRoot,
        env: context.env,
      });
      assert.equal(replacements, state === 'prepared' || state === 'temporary-written' ? 0 : 1);
      assert.equal((await readCandidateState({
        projectRoot: context.projectRoot,
        env: context.env,
        candidateId: context.candidateId,
      })).state, 'consumed');
      const journal = await readApplyJournal({
        projectRoot: context.projectRoot,
        env: context.env,
        transactionId: 'transactionId' in context ? context.transactionId : undefined,
        candidateId: context.candidateId,
      });
      assert.equal(journal.state, 'complete');
      if (!['prepared', 'temporary-written'].includes(state)) {
        assert.equal(await fs.readFile(context.destination, 'utf8'), context.content);
        assert.equal((await classifyRestoreReceipt({
          projectRoot: context.projectRoot,
          env: context.env,
          receiptId: journal.transactionId,
        })).classification, 'audit-only');
      } else {
        assert.equal(await fs.readFile(context.destination, 'utf8'), 'before');
      }
    });
  }

  for (const boundary of [
    'prepared',
    'temporary-written',
    'destination-replaced',
    'receipt-committed',
    'consumed-marker-committed',
  ]) {
    it(`SIGKILL at ${boundary}: reclaims the abandoned lock and converges`, async () => {
      const context = await fixture();
      const replaced = !['prepared', 'temporary-written'].includes(boundary);
      const result = spawnSync(process.execPath, [CHILD], {
        env: {
          ...process.env,
          CRASH_HOME: context.env.NOOSPHERE_HOME,
          CRASH_PROJECT: context.projectRoot,
          CRASH_SCOPE: context.env.NOOSPHERE_OWNER_SCOPE,
          CRASH_CANDIDATE: context.candidateId,
          CRASH_AT: boundary,
        },
        timeout: 30000,
        killSignal: 'SIGKILL',
      });
      assert.equal(result.error, undefined,
        `child spawn errored or timed out: ${result.error?.message}`);
      assert.ok(result.signal === 'SIGKILL' || result.status !== 0,
        `child must be forcibly terminated (signal=${result.signal}, status=${result.status})`);
      if (process.platform !== 'win32') assert.equal(result.signal, 'SIGKILL');

      // A real crash leaves the slot lock held. Phase 4C recovery reclaims it,
      // but only because inspectLock authenticates it as this project's own
      // lock for this transaction AND the writing PID is provably gone. The
      // lock is not removed by hand and not removed by age.
      const store = createFormatV2Store({ env: context.env });
      const binding = await store.readProjectBinding(context.projectRoot);
      const heldLock = await store.inspectLock(binding, 'baseline');
      assert.notEqual(heldLock, null);
      assert.equal(classifyLockLiveness(heldLock), 'abandoned');

      await recoverRestoreTransactions({
        projectRoot: context.projectRoot,
        env: context.env,
      });
      const first = await fs.readFile(context.destination);
      await recoverRestoreTransactions({
        projectRoot: context.projectRoot,
        env: context.env,
      });
      assert.deepEqual(await fs.readFile(context.destination), first);
      assert.equal(
        first.toString('utf8'),
        replaced ? context.content : 'before',
      );
      assert.equal((await readCandidateState({
        projectRoot: context.projectRoot,
        env: context.env,
        candidateId: context.candidateId,
      })).state, 'consumed');
      const journal = await readApplyJournal({
        projectRoot: context.projectRoot,
        env: context.env,
        candidateId: context.candidateId,
      });
      assert.equal(journal.state, 'complete');
      assert.equal(journal.outcome, replaced ? 'applied' : 'failed');
      const temporaryPath = path.join(
        context.projectRoot,
        ...journal.temporaryPath.split('/'),
      );
      await assert.rejects(fs.access(temporaryPath));
    });
  }

  it('requires owner intervention when post-rename destination bytes changed', async () => {
    const context = await fixture();
    await assert.rejects(
      applyRestoreCandidate({
        projectRoot: context.projectRoot,
        env: context.env,
        candidateId: context.candidateId,
        confirm: () => true,
        afterJournalState: crashAt('destination-replaced'),
      }),
      error => error.simulatedCrash === true,
    );
    await fs.writeFile(context.destination, 'owner changed after rename');
    await assert.rejects(
      recoverRestoreTransactions({
        projectRoot: context.projectRoot,
        env: context.env,
      }),
      error => error.code === 'ERR_RESTORE_OWNER_INTERVENTION_REQUIRED',
    );
    assert.equal(
      await fs.readFile(context.destination, 'utf8'),
      'owner changed after rename',
    );
  });
});
