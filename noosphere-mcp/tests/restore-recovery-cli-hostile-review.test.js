import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import { approveSlot } from '../continuity/internal/approval-service.js';
import { readApplyJournal } from '../continuity/internal/restore/apply-journal.js';
import {
  listApplyInProgressCandidates,
  listRestoreCandidates,
  markApplyInProgress,
  readCandidateState,
} from '../continuity/internal/restore/candidate-store.js';
import {
  issueConfirmation,
  spendContext,
} from '../continuity/internal/restore/confirmation-store.js';
import { createFormatV2Store } from '../continuity/internal/trust-format-v2.js';
import {
  clearSlotLockAsOwner,
  cli,
  crash,
  fixture,
} from './helpers/restore-recovery-cli-fixture.js';

describe('SEC-05 Phase 4C — hostile-review recovery findings', () => {
  it('leaves a destination changed after the committed replacement untouched', async () => {
    const context = await fixture();
    crash(context, 'destination-replaced');
    await clearSlotLockAsOwner(context);
    // A third party rewrites the destination after the replacement committed.
    await fs.writeFile(context.destination, 'tampered after the rename\n');

    const result = cli(context, ['recover']);
    assert.equal(result.status, 4, `expected a security refusal, got ${result.status}`);
    assert.match(result.stderr, /destination bytes do not match the authenticated replacement/);
    assert.equal(
      (await fs.readFile(context.destination)).toString('utf8'),
      'tampered after the rename\n',
      'recovery overwrote a destination it must not touch',
    );
    const journal = await readApplyJournal({
      projectRoot: context.projectRoot,
      env: context.env,
      candidateId: context.candidateId,
    });
    assert.notEqual(journal.state, 'complete');
  });

  // FINDING A: the atomic rename and the `destination-replaced` journal event
  // are two steps. A crash between them left the journal at `temporary-written`
  // while the destination already held the replacement; recovery called that
  // `discarded`, committed outcome `failed`, and consumed the candidate as
  // failed — telling the owner nothing happened, with the new bytes on disk.
  it('converges a rename that committed before its journal event', async () => {
    const context = await fixture();
    // Crash exactly at temporary-written, then perform the rename by hand: this
    // is the on-disk state a crash in that window leaves behind.
    crash(context, 'temporary-written');
    const journal = await readApplyJournal({
      projectRoot: context.projectRoot,
      env: context.env,
      candidateId: context.candidateId,
    });
    assert.equal(journal.state, 'temporary-written');
    const temporaryPath = path.join(context.projectRoot, ...journal.temporaryPath.split('/'));
    await fs.rename(temporaryPath, context.destination);
    await clearSlotLockAsOwner(context);
    assert.equal(await fs.readFile(context.destination, 'utf8'), context.content);

    const recovered = cli(context, ['recover']);
    assert.equal(recovered.status, 0, `restore recover failed: ${recovered.stderr}`);

    const after = await readApplyJournal({
      projectRoot: context.projectRoot,
      env: context.env,
      candidateId: context.candidateId,
    });
    assert.equal(after.state, 'complete');
    assert.equal(after.outcome, 'applied',
      'a committed rename was recorded as a failed apply');
    assert.equal(await fs.readFile(context.destination, 'utf8'), context.content,
      'recovery reverted or corrupted a committed replacement');
    assert.equal((await readCandidateState({
      projectRoot: context.projectRoot,
      env: context.env,
      candidateId: context.candidateId,
    })).state, 'consumed');
  });

  it('requires owner intervention when the destination is neither pre-state nor replacement', async () => {
    const context = await fixture();
    crash(context, 'temporary-written');
    await clearSlotLockAsOwner(context);
    await fs.writeFile(context.destination, 'a third value entirely\n');

    const result = cli(context, ['recover']);
    assert.equal(result.status, 4, `expected a security refusal, got ${result.status}`);
    assert.match(result.stderr, /neither the authenticated pre-state nor the authenticated replacement/);
    assert.equal(await fs.readFile(context.destination, 'utf8'), 'a third value entirely\n');
  });

  // FINDING B: a crash between markApplyInProgress and createApplyJournal
  // leaves a candidate mid-apply with a spent confirmation and no journal.
  // Nothing enumerated it, so it could never be applied and never be restaged.
  it('releases a candidate stranded mid-apply with no journal', async () => {
    const context = await fixture();
    // Reconstruct exactly the on-disk state a crash in that window leaves: a
    // spent confirmation and an apply-in-progress candidate, no journal. The
    // apply service offers no seam between markApplyInProgress and
    // createApplyJournal, so the state is built with the same primitives it
    // uses, in the same order.
    const issued = await issueConfirmation({
      projectRoot: context.projectRoot,
      env: context.env,
      candidateId: context.candidateId,
      destination: { state: 'present', rawHash: createHash('sha256').update('before').digest('hex') },
      manifest: { state: 'pristine-unapproved', generation: { state: 'no-manifest' } },
    });
    const transactionId = randomUUID();
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

    const stranded = await listApplyInProgressCandidates({
      projectRoot: context.projectRoot,
      env: context.env,
    });
    assert.equal(stranded.length, 1, 'the fixture did not strand a candidate');
    assert.equal(stranded[0].candidateId, context.candidateId);
    // It is invisible to every other listing — that is what made it stranded.
    assert.deepEqual(
      await listRestoreCandidates({ projectRoot: context.projectRoot, env: context.env }),
      [],
    );

    const recovered = cli(context, ['recover']);
    assert.equal(recovered.status, 0, `restore recover failed: ${recovered.stderr}`);
    assert.equal((await readCandidateState({
      projectRoot: context.projectRoot,
      env: context.env,
      candidateId: context.candidateId,
    })).state, 'consumed', 'the stranded candidate was not released');
    assert.deepEqual(
      await listApplyInProgressCandidates({
        projectRoot: context.projectRoot, env: context.env,
      }),
      [],
    );
    // No journal ever existed, so no destination was ever touched.
    assert.equal(await fs.readFile(context.destination, 'utf8'), 'before');
  });

  it('cannot strand a candidate that does not own its spent confirmation', async () => {
    const context = await fixture();
    const issued = await issueConfirmation({
      projectRoot: context.projectRoot,
      env: context.env,
      candidateId: context.candidateId,
      destination: { state: 'present', rawHash: createHash('sha256').update('before').digest('hex') },
      manifest: { state: 'pristine-unapproved', generation: { state: 'no-manifest' } },
    });
    await spendContext({
      projectRoot: context.projectRoot,
      env: context.env,
      contextId: issued.contextId,
      transactionId: randomUUID(),
    });

    // The reason recovery can trust a stranded candidate at all: the candidate
    // store refuses to mark one in-progress for a transaction that did not spend
    // its confirmation, so the state releaseStrandedCandidate meets is always
    // one a genuine apply created. Its own confirmation check is defence in
    // depth against hand-edited owner-local state.
    await assert.rejects(
      markApplyInProgress({
        projectRoot: context.projectRoot,
        env: context.env,
        candidateId: context.candidateId,
        contextId: issued.contextId,
        transactionId: randomUUID(),
      }),
      (error) => error.code === 'ERR_RESTORE_CANDIDATE_TRANSITION',
      'a candidate was marked in-progress by a foreign transaction',
    );
    assert.deepEqual(
      await listApplyInProgressCandidates({
        projectRoot: context.projectRoot, env: context.env,
      }),
      [],
    );
  });

  // FINDING C: the recovery barrier must refuse when the manifest moved after
  // the owner confirmed. Recovery previously completed a destination-replaced
  // transaction confirmed against pristine-unapproved state after the slot had
  // been approved.
  it('requires owner intervention when the manifest moved after confirmation', async () => {
    const context = await fixture();
    crash(context, 'destination-replaced');
    const before = await readApplyJournal({
      projectRoot: context.projectRoot,
      env: context.env,
      candidateId: context.candidateId,
    });
    assert.equal(before.manifest.state, 'pristine-unapproved');

    // Clear the crashed transaction's abandoned lock so the approval can run;
    // the point under test is the manifest moving, not lock contention.
    const store = createFormatV2Store({ env: context.env });
    const binding = await store.readProjectBinding(context.projectRoot);
    await fs.rm(store.lockPath(binding, 'baseline'), { force: true });

    // The owner approves the slot while the transaction is still unfinished.
    await approveSlot({
      projectRoot: context.projectRoot,
      slot: 'baseline',
      env: context.env,
      confirm: () => true,
    });

    const result = cli(context, ['recover']);
    assert.equal(result.status, 4, `expected a security refusal, got ${result.status}`);
    assert.match(result.stderr, /manifest state changed after the owner confirmed/);
    const after = await readApplyJournal({
      projectRoot: context.projectRoot,
      env: context.env,
      candidateId: context.candidateId,
    });
    assert.notEqual(after.state, 'complete', 'recovery completed across a manifest change');
  });
});
