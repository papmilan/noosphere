import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { applyRestoreCandidate } from '../continuity/internal/restore/apply-service.js';
import { approveSlot } from '../continuity/internal/approval-service.js';
import {
  consumeCandidate,
  markApplyInProgress,
  readCandidateState,
  stageRestoreCandidate,
} from '../continuity/internal/restore/candidate-store.js';
import {
  issueConfirmation,
  spendContext,
} from '../continuity/internal/restore/confirmation-store.js';
import { readApplyJournal } from '../continuity/internal/restore/apply-journal.js';
import { classifyLockLiveness, recoverRestoreTransactions } from '../continuity/internal/restore/recovery.js';
import {
  classifyRestoreReceipt,
  readConsumedMarker,
  readRestoreReceipt,
} from '../continuity/internal/restore/receipt-store.js';
import { createFormatV2Store } from '../continuity/internal/trust-format-v2.js';
import * as secureFs from '../continuity/secure-fs.js';

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

async function strandCandidateWhileHoldingLock(context) {
  const issued = await issueConfirmation({
    projectRoot: context.projectRoot,
    env: context.env,
    candidateId: context.candidateId,
    destination: {
      state: 'present',
      rawHash: createHash('sha256').update('before').digest('hex'),
    },
    manifest: {
      state: 'pristine-unapproved',
      generation: { state: 'no-manifest' },
    },
  });
  const transactionId = randomUUID();
  const store = createFormatV2Store({ env: context.env });
  const binding = await store.readProjectBinding(context.projectRoot);
  const lock = await store.acquireLock(binding, 'baseline', transactionId);
  await spendContext({
    projectRoot: context.projectRoot,
    env: context.env,
    contextId: issued.contextId,
    transactionId,
  });
  await markApplyInProgress({
    projectRoot: context.projectRoot,
    env: context.env,
    candidateId: context.candidateId,
    contextId: issued.contextId,
    transactionId,
  });
  return { lock, transactionId };
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
    it(`SIGKILL at ${boundary}: waits for owner lock removal and converges`, async () => {
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
        timeout: 300000,
        killSignal: 'SIGKILL',
      });
      assert.equal(result.error, undefined,
        `child spawn errored or timed out: ${result.error?.message}`);
      assert.ok(result.signal === 'SIGKILL' || result.status !== 0,
        `child must be forcibly terminated (signal=${result.signal}, status=${result.status})`);
      if (process.platform !== 'win32') assert.equal(result.signal, 'SIGKILL');

      // A real crash leaves the slot lock held. Recovery never removes it,
      // regardless of ownership or liveness; the owner clears it explicitly.
      const store = createFormatV2Store({ env: context.env });
      const binding = await store.readProjectBinding(context.projectRoot);
      const heldLock = await store.inspectLock(binding, 'baseline');
      assert.notEqual(heldLock, null);
      assert.equal(classifyLockLiveness(heldLock), 'abandoned');
      const lockPath = store.lockPath(binding, 'baseline');
      const lockBytes = await fs.readFile(lockPath);

      await assert.rejects(
        recoverRestoreTransactions({
          projectRoot: context.projectRoot,
          env: context.env,
        }),
        error => error.code === 'ERR_RESTORE_OWNER_INTERVENTION_REQUIRED',
      );
      assert.deepEqual(await fs.readFile(lockPath), lockBytes);
      await fs.rm(lockPath);

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

  it('does not consume a journal-less candidate while its live apply holds the slot lock', async () => {
    const context = await fixture();
    const { lock, transactionId } = await strandCandidateWhileHoldingLock(context);
    try {
      await assert.rejects(
        recoverRestoreTransactions({
          projectRoot: context.projectRoot,
          env: context.env,
        }),
        error => error.code === 'ERR_RESTORE_OWNER_INTERVENTION_REQUIRED',
        'recovery consumed a candidate between markApplyInProgress and journal creation',
      );
      const state = await readCandidateState({
        projectRoot: context.projectRoot,
        env: context.env,
        candidateId: context.candidateId,
      });
      assert.equal(state.state, 'apply-in-progress');
      assert.equal(state.transactionId, transactionId);
    } finally {
      await lock.release();
    }
  });

  it('repeats the manifest barrier under the recovery lock', async () => {
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

    await assert.rejects(
      recoverRestoreTransactions({
        projectRoot: context.projectRoot,
        env: context.env,
        beforeRecoveryLock: async () => {
          await approveSlot({
            projectRoot: context.projectRoot,
            slot: 'baseline',
            env: context.env,
            confirm: () => true,
          });
        },
      }),
      error =>
        error.code === 'ERR_RESTORE_OWNER_INTERVENTION_REQUIRED' &&
        /manifest state changed/.test(error.message),
      'recovery advanced on the manifest observation taken before acquiring its lock',
    );
    assert.notEqual((await readApplyJournal({
      projectRoot: context.projectRoot,
      env: context.env,
      candidateId: context.candidateId,
    })).state, 'complete');
  });

  it('never infers a destination replacement from a prepared journal', async () => {
    const context = await fixture();
    await assert.rejects(
      applyRestoreCandidate({
        projectRoot: context.projectRoot,
        env: context.env,
        candidateId: context.candidateId,
        confirm: () => true,
        afterJournalState: crashAt('prepared'),
      }),
      error => error.simulatedCrash === true,
    );
    await fs.writeFile(context.destination, context.content);

    await assert.rejects(
      recoverRestoreTransactions({
        projectRoot: context.projectRoot,
        env: context.env,
      }),
      error =>
        error.code === 'ERR_RESTORE_OWNER_INTERVENTION_REQUIRED' &&
        /authenticated pre-state/.test(error.message),
      'a prepared journal was promoted as though its destination rename could have committed',
    );
    const journal = await readApplyJournal({
      projectRoot: context.projectRoot,
      env: context.env,
      candidateId: context.candidateId,
    });
    assert.equal(journal.state, 'prepared');
    assert.equal(journal.outcome, null);
  });

  it('leaves an abandoned lock byte-identical until the owner clears it', async () => {
    const context = await fixture();
    const result = spawnSync(process.execPath, [CHILD], {
      env: {
        ...process.env,
        CRASH_HOME: context.env.NOOSPHERE_HOME,
        CRASH_PROJECT: context.projectRoot,
        CRASH_SCOPE: context.env.NOOSPHERE_OWNER_SCOPE,
        CRASH_CANDIDATE: context.candidateId,
        CRASH_AT: 'destination-replaced',
      },
      timeout: 300000,
      killSignal: 'SIGKILL',
    });
    assert.equal(result.error, undefined);
    assert.ok(result.signal === 'SIGKILL' || result.status !== 0);

    const store = createFormatV2Store({ env: context.env });
    const binding = await store.readProjectBinding(context.projectRoot);
    const lockPath = store.lockPath(binding, 'baseline');
    const before = await fs.readFile(lockPath);
    await assert.rejects(
      recoverRestoreTransactions({
        projectRoot: context.projectRoot,
        env: context.env,
      }),
      error => error.code === 'ERR_RESTORE_OWNER_INTERVENTION_REQUIRED',
      'recovery automatically removed an abandoned lock',
    );
    assert.deepEqual(await fs.readFile(lockPath), before);

    await fs.rm(lockPath);
    await recoverRestoreTransactions({
      projectRoot: context.projectRoot,
      env: context.env,
    });
    const journal = await readApplyJournal({
      projectRoot: context.projectRoot,
      env: context.env,
      candidateId: context.candidateId,
    });
    assert.equal(journal.state, 'complete');
    assert.equal(journal.outcome, 'applied');
  });

  it('refuses a conflicting candidate namespace under lock before any mutation', async () => {
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
    const before = await readApplyJournal({
      projectRoot: context.projectRoot,
      env: context.env,
      candidateId: context.candidateId,
    });

    await assert.rejects(
      recoverRestoreTransactions({
        projectRoot: context.projectRoot,
        env: context.env,
        beforeRecoveryLock: async () => {
          await consumeCandidate({
            projectRoot: context.projectRoot,
            env: context.env,
            candidateId: context.candidateId,
            transactionId: before.transactionId,
            outcome: 'failed',
          });
        },
      }),
      error => error.code === 'ERR_RESTORE_OWNER_INTERVENTION_REQUIRED',
    );
    const after = await readApplyJournal({
      projectRoot: context.projectRoot,
      env: context.env,
      candidateId: context.candidateId,
    });
    assert.equal(after.state, before.state);
    assert.equal(after.stateEventHash, before.stateEventHash);
    assert.equal(await readRestoreReceipt({
      projectRoot: context.projectRoot,
      env: context.env,
      receiptId: before.receiptId,
      missingAllowed: true,
    }), null);
    assert.equal(await readConsumedMarker({
      projectRoot: context.projectRoot,
      env: context.env,
      candidateId: context.candidateId,
      missingAllowed: true,
    }), null);
    await assert.rejects(
      fs.access(path.join(context.projectRoot, ...before.temporaryPath.split('/'))),
    );
  });

  it('discards an exact temporary left while the journal is still prepared', async () => {
    const context = await fixture();
    await assert.rejects(
      applyRestoreCandidate({
        projectRoot: context.projectRoot,
        env: context.env,
        candidateId: context.candidateId,
        confirm: () => true,
        afterJournalState: crashAt('prepared'),
      }),
      error => error.simulatedCrash === true,
    );
    const journal = await readApplyJournal({
      projectRoot: context.projectRoot,
      env: context.env,
      candidateId: context.candidateId,
    });
    const prepared = await secureFs.prepareOwnerOnlyReplacement(
      context.destination,
      context.content,
      {
        root: context.projectRoot,
        expectedDestination: await secureFs.inspectOwnerOnlyDestination(
          context.destination,
          { root: context.projectRoot },
        ),
        randomUUID: () => journal.transactionId,
      },
    );
    assert.equal(prepared.temporaryPath,
      path.join(context.projectRoot, ...journal.temporaryPath.split('/')));

    await recoverRestoreTransactions({
      projectRoot: context.projectRoot,
      env: context.env,
    });
    await assert.rejects(fs.access(prepared.temporaryPath),
      'prepared recovery orphaned its exact authenticated temporary');
    assert.equal(await fs.readFile(context.destination, 'utf8'), 'before');
    const after = await readApplyJournal({
      projectRoot: context.projectRoot,
      env: context.env,
      candidateId: context.candidateId,
    });
    assert.equal(after.state, 'complete');
    assert.equal(after.outcome, 'failed');
  });

  for (const boundary of ['prepared', 'temporary-written']) {
    it(`keeps an early ${boundary} journal failed after candidate consumption`, async () => {
      const context = await fixture();
      // Make the authenticated pre-state byte-identical to the candidate. At
      // temporary-written this makes destination bytes alone unable to prove
      // whether the rename happened.
      await fs.writeFile(context.destination, context.content);
      await assert.rejects(
        applyRestoreCandidate({
          projectRoot: context.projectRoot,
          env: context.env,
          candidateId: context.candidateId,
          confirm: () => true,
          afterJournalState: crashAt(boundary),
        }),
        error => error.simulatedCrash === true,
      );
      const before = await readApplyJournal({
        projectRoot: context.projectRoot,
        env: context.env,
        candidateId: context.candidateId,
      });
      assert.equal(before.state, boundary);

      // Reconstruct an interruption after failed-path cleanup consumed the
      // candidate but before it appended the terminal journal event.
      await fs.rm(path.join(
        context.projectRoot,
        ...before.temporaryPath.split('/'),
      ), { force: true });
      const candidate = await readCandidateState({
        projectRoot: context.projectRoot,
        env: context.env,
        candidateId: context.candidateId,
      });
      assert.equal(candidate.state, 'consumed');
      assert.equal(candidate.transactionId, before.transactionId);
      assert.equal(candidate.outcome, 'failed');

      const recovered = await recoverRestoreTransactions({
        projectRoot: context.projectRoot,
        env: context.env,
      });
      assert.equal(recovered[0].status, 'discarded');
      const after = await readApplyJournal({
        projectRoot: context.projectRoot,
        env: context.env,
        candidateId: context.candidateId,
      });
      assert.equal(after.state, 'complete');
      assert.equal(after.outcome, 'failed');
      assert.equal(await readRestoreReceipt({
        projectRoot: context.projectRoot,
        env: context.env,
        receiptId: before.receiptId,
        missingAllowed: true,
      }), null);
      assert.equal(await readConsumedMarker({
        projectRoot: context.projectRoot,
        env: context.env,
        candidateId: context.candidateId,
        missingAllowed: true,
      }), null);
    });
  }
});
