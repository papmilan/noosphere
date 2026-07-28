// SEC-05 Phase 4C Task 9 Step 4 (first half) — concurrent authority transitions.
//
// Every ordered pair of {approve, revoke, migration approval, restore apply} is
// raced against the same serialization key (one project, one slot). The
// invariants under test are the ones that make an append-only authority log
// meaningful under concurrency:
//
//   - exactly one transition may commit from a given observed generation;
//   - the loser receives a TYPED refusal, never a silent no-op and never an
//     untyped crash;
//   - no generation is ever reused;
//   - a tombstone is never bypassed by a racing approval;
//   - an apply never lands against stale destination bytes;
//   - the audit chain stays verifiable, so no event is lost.
//
// The races are real concurrency: both sides observe state, then both attempt
// to commit, with the observation deliberately taken before either commits.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, it } from 'node:test';

import { approveSlot } from '../continuity/internal/approval-service.js';
import { revokeSlot } from '../continuity/internal/revocation-service.js';
import { migrateTrustInventory } from '../continuity/internal/migration-service.js';
import { applyRestoreCandidate } from '../continuity/internal/restore/apply-service.js';
import { stageRestoreCandidate } from '../continuity/internal/restore/candidate-store.js';
import { createFormatV2Store } from '../continuity/internal/trust-format-v2.js';
import { TrustStoreError } from '../continuity/trust-store-internal.js';
import { isSlotAuthoritative } from '../continuity/trust-store.js';
import { putSlotRecord } from '../continuity/trust-store-internal.js';
import { resolveSlotSource } from '../continuity/slot-sources.js';

const SLOT = 'baseline';
const temporary = [];
after(async () => {
  await Promise.all(temporary.map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

function ttyStreams() {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  output.isTTY = true;
  return { input, output };
}

async function project({ approve = true, legacy = false } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'race-home-'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'race-project-'));
  temporary.push(home, root);
  await fs.mkdir(path.join(root, '.noosphere'), { recursive: true });
  const body = '# Noosphere project baseline\n\nraced body\n';
  await fs.writeFile(path.join(root, '.noosphere', 'baseline.md'), body);
  const env = { NOOSPHERE_HOME: home, NOOSPHERE_OWNER_SCOPE: 'race-owner' };
  if (legacy) await putSlotRecord({ projectRoot: root, slot: SLOT, rawBytes: body, env });
  if (approve) await approveSlot({ projectRoot: root, slot: SLOT, env, confirm: () => true });
  return {
    env,
    root,
    body,
    destination: path.join(root, '.noosphere', 'baseline.md'),
    store: createFormatV2Store({ env }),
  };
}

/** The bytes production would actually authorize: `baseline` derives its source
 *  from the file rather than using the raw bytes, so a test must ask the same
 *  resolver the ceremony asks. */
async function authoritativeNow(context) {
  const source = await resolveSlotSource(context.root, SLOT);
  return isSlotAuthoritative({
    projectRoot: context.root, slot: SLOT, env: context.env, rawBytes: source.bytes,
  });
}

async function manifestOf(context) {
  const binding = await context.store.readProjectBinding(context.root);
  return context.store.readManifest(binding, SLOT);
}

/** Runs both sides concurrently and classifies the outcomes. */
async function race(left, right) {
  const settled = await Promise.allSettled([left(), right()]);
  const committed = settled.filter((entry) => entry.status === 'fulfilled');
  const refused = settled.filter((entry) => entry.status === 'rejected');
  return { settled, committed, refused };
}

/** Every refusal must be a typed security error, never an untyped crash. */
function assertTypedRefusals(refused, label) {
  for (const entry of refused) {
    const error = entry.reason;
    assert.ok(
      error instanceof TrustStoreError || typeof error?.code === 'string',
      `${label}: refusal is untyped: ${error?.stack ?? error}`,
    );
    assert.ok(
      typeof error.code === 'string' && error.code.length > 0,
      `${label}: refusal carries no code`,
    );
  }
}

/** The append-only log must remain intact whatever the race did. */
async function assertLogIntact(context, label) {
  const binding = await context.store.readProjectBinding(context.root);
  assert.equal(
    await context.store.verifyAuditChain(binding, SLOT),
    true,
    `${label}: the audit chain no longer verifies — an event was lost or rewritten`,
  );
}

describe('SEC-05 Phase 4C — concurrent authority transitions', () => {
  // ------------------------------------------------ same-generation contention

  it('lets exactly one transition commit from one observed generation', async () => {
    // Both sides observe generation N and then both commit against it. Only one
    // may win; the loser must be refused with authority-state-changed, not
    // silently folded into the winner's generation.
    for (const [label, second] of [
      ['approve/approve', 'approve'],
      ['approve/revoke', 'revoke'],
      ['revoke/approve', 'approve'],
    ]) {
      const context = await project();
      const observed = await manifestOf(context);
      const expectedCurrent = Object.freeze({
        state: observed.currentState,
        generation: observed.currentGeneration,
        recordId: observed.currentRecordId,
        recordHash: observed.currentRecordHash,
      });
      const attempt = (kind) => (kind === 'approve'
        ? approveSlot({
            projectRoot: context.root, slot: SLOT, env: context.env,
            confirm: () => true, expectedCurrent,
          })
        : revokeSlot({
            projectRoot: context.root, slot: SLOT, env: context.env,
            confirm: () => true,
          }));
      const first = label.startsWith('approve') ? 'approve' : 'revoke';

      const { committed, refused } = await race(
        () => attempt(first),
        () => attempt(second),
      );
      assert.equal(committed.length, 1, `${label}: ${committed.length} transitions committed`);
      assert.equal(refused.length, 1, `${label}: expected exactly one refusal`);
      assertTypedRefusals(refused, label);

      const after = await manifestOf(context);
      assert.equal(
        after.currentGeneration,
        observed.currentGeneration + 1,
        `${label}: generation advanced by ${after.currentGeneration - observed.currentGeneration}`,
      );
      await assertLogIntact(context, label);
    }
  });

  // The concurrent races above are serialized by the slot lock, so they do NOT
  // exercise the same-generation guard — removing it leaves them green. This
  // does: both sides observe generation N and take the lock in sequence, which
  // is the real "two operators read the same state" case. Only the guard can
  // refuse the second one.
  it('refuses a second commit against an already-spent observed generation', async () => {
    for (const kind of ['approve', 'revoke']) {
      const context = await project();
      const observed = await manifestOf(context);
      const expectedCurrent = Object.freeze({
        state: observed.currentState,
        generation: observed.currentGeneration,
        recordId: observed.currentRecordId,
        recordHash: observed.currentRecordHash,
      });

      // First operator commits from the observation.
      const commit = async () => (kind === 'approve'
        ? approveSlot({
            projectRoot: context.root, slot: SLOT, env: context.env,
            confirm: () => true, expectedCurrent,
          })
        : context.store.commitRevocation({
            binding: await context.store.readProjectBinding(context.root),
            slot: SLOT,
            sourceOrigin: `cli:trust-revoke:${SLOT}`,
            expectedCurrent,
          }));
      await commit();
      const between = await manifestOf(context);
      assert.equal(between.currentGeneration, observed.currentGeneration + 1);

      // Second operator, still holding the stale observation, must be refused —
      // no lock contention involved, the first transition is already finished.
      await assert.rejects(
        commit(),
        (error) => error instanceof TrustStoreError &&
          /authority-state-changed|revocation-state-changed/.test(error.code),
        `${kind}: a stale observed generation was accepted`,
      );
      const after = await manifestOf(context);
      assert.equal(after.currentGeneration, between.currentGeneration,
        `${kind}: the refused commit still advanced the generation`);
      await assertLogIntact(context, `stale ${kind}`);
    }
  });

  it('never reuses a generation across a burst of racing approvals', async () => {
    const context = await project();
    const before = (await manifestOf(context)).currentGeneration;
    const attempts = Array.from({ length: 6 }, () => () => approveSlot({
      projectRoot: context.root, slot: SLOT, env: context.env, confirm: () => true,
    }));
    const settled = await Promise.allSettled(attempts.map((run) => run()));
    const committed = settled.filter((entry) => entry.status === 'fulfilled');
    assertTypedRefusals(settled.filter((entry) => entry.status === 'rejected'), 'burst');

    // Unconstrained approvals may legitimately queue behind the lock, so the
    // requirement is not "one winner" — it is that every winner took a distinct
    // generation and the manifest advanced by exactly that many.
    const generations = committed.map((entry) => entry.value.manifest.currentGeneration);
    assert.deepEqual(
      [...new Set(generations)].sort((a, b) => a - b),
      [...generations].sort((a, b) => a - b),
      'a generation was reused by two committed approvals',
    );
    const after = await manifestOf(context);
    assert.equal(after.currentGeneration, before + committed.length,
      'the manifest generation does not account for exactly the committed approvals');
    await assertLogIntact(context, 'burst');
  });

  // ------------------------------------------------------- tombstone integrity

  it('never lets a racing approval bypass a tombstone', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const context = await project();
      const { committed, refused } = await race(
        () => revokeSlot({
          projectRoot: context.root, slot: SLOT, env: context.env, confirm: () => true,
        }),
        () => approveSlot({
          projectRoot: context.root, slot: SLOT, env: context.env, confirm: () => true,
        }),
      );
      assertTypedRefusals(refused, 'tombstone race');
      assert.ok(committed.length >= 1, 'neither side committed');

      // Whatever order the lock granted, the final state must be internally
      // consistent: authority is true only if the manifest's current state is
      // an approval of exactly these bytes.
      const after = await manifestOf(context);
      const authoritative = await authoritativeNow(context);
      assert.equal(
        authoritative,
        after.currentState === 'approved',
        'authority disagrees with the manifest after a revoke/approve race',
      );
      // A revoked slot authorizes nothing, whichever way the race went.
      if (after.currentState === 'revoked') assert.equal(authoritative, false);
      await assertLogIntact(context, 'tombstone race');
    }
  });

  // ------------------------------------------------------- migration contention

  it('races per-slot migration approval against a direct approval', async () => {
    const context = await project({ approve: false, legacy: true });
    const { committed, refused } = await race(
      () => migrateTrustInventory({
        projectRoot: context.root, env: context.env, confirm: () => true,
      }),
      () => approveSlot({
        projectRoot: context.root, slot: SLOT, env: context.env, confirm: () => true,
      }),
    );
    assertTypedRefusals(refused, 'migration race');
    assert.ok(committed.length >= 1, 'neither migration nor approval committed');

    // Migration pins expectedCurrent to pristine-unapproved, so a direct
    // approval that wins the lock must make the migration refuse rather than
    // mint a second generation-1 record.
    const after = await manifestOf(context);
    assert.equal(after.currentGeneration, 1,
      `a migration/approval race produced generation ${after.currentGeneration}`);
    assert.equal(after.currentState, 'approved');
    await assertLogIntact(context, 'migration race');
  });

  // ---------------------------------------------------------- restore contention

  it('never applies two restores to the same destination concurrently', async () => {
    const context = await project();
    const stage = async (marker) => (await stageRestoreCandidate({
      projectRoot: context.root,
      slot: SLOT,
      env: context.env,
      ...ttyStreams(),
      recall: async () => ({
        memories: [{ action_type: 'project-baseline', content: `# baseline\n\n${marker}\n` }],
      }),
    })).candidate.candidateId;
    const left = await stage('left');
    const right = await stage('right');

    const { committed, refused } = await race(
      () => applyRestoreCandidate({
        projectRoot: context.root, candidateId: left, env: context.env, confirm: () => true,
      }),
      () => applyRestoreCandidate({
        projectRoot: context.root, candidateId: right, env: context.env, confirm: () => true,
      }),
    );
    assertTypedRefusals(refused, 'apply race');

    // The destination must equal exactly one committed apply's payload — never
    // a blend, and never the loser's bytes.
    const bytes = await fs.readFile(context.destination, 'utf8');
    const winners = committed.map((entry) => entry.value.candidateId);
    if (winners.length === 0) {
      assert.equal(bytes, context.body, 'a fully refused race still changed the destination');
    } else {
      assert.equal(winners.length, 1,
        'two applies committed against the same destination concurrently');
      const marker = winners[0] === left ? 'left' : 'right';
      assert.equal(bytes, `# baseline\n\n${marker}\n`,
        'the destination does not match the single committed apply');
    }
    await assertLogIntact(context, 'apply race');
  });

  it('never lets a restore apply land against stale destination bytes', async () => {
    const context = await project();
    const candidateId = (await stageRestoreCandidate({
      projectRoot: context.root,
      slot: SLOT,
      env: context.env,
      ...ttyStreams(),
      recall: async () => ({
        memories: [{ action_type: 'project-baseline', content: '# baseline\n\nfrom recall\n' }],
      }),
    })).candidate.candidateId;

    // A third party rewrites the destination between the owner's confirmation
    // and the replacement. The apply must refuse rather than overwrite bytes it
    // never showed the owner.
    await assert.rejects(
      applyRestoreCandidate({
        projectRoot: context.root,
        candidateId,
        env: context.env,
        confirm: () => true,
        afterConfirmation: async () => {
          await fs.writeFile(context.destination, 'changed under the ceremony\n');
        },
      }),
      (error) => typeof error.code === 'string',
      'an apply committed against destination bytes the owner never saw',
    );
    assert.equal(
      await fs.readFile(context.destination, 'utf8'),
      'changed under the ceremony\n',
      'the refused apply still replaced the destination',
    );
    await assertLogIntact(context, 'stale destination');
  });

  it('races a restore apply against an authority transition on the same slot', async () => {
    for (const [label, other] of [['apply/approve', 'approve'], ['apply/revoke', 'revoke']]) {
      const context = await project();
      const candidateId = (await stageRestoreCandidate({
        projectRoot: context.root,
        slot: SLOT,
        env: context.env,
        ...ttyStreams(),
        recall: async () => ({
          memories: [{ action_type: 'project-baseline', content: '# baseline\n\nraced restore\n' }],
        }),
      })).candidate.candidateId;

      const { refused } = await race(
        () => applyRestoreCandidate({
          projectRoot: context.root, candidateId, env: context.env, confirm: () => true,
        }),
        () => (other === 'approve'
          ? approveSlot({
              projectRoot: context.root, slot: SLOT, env: context.env, confirm: () => true,
            })
          : revokeSlot({
              projectRoot: context.root, slot: SLOT, env: context.env, confirm: () => true,
            })),
      );
      assertTypedRefusals(refused, label);

      // Authority is always recomputed, never inherited from the race.
      const after = await manifestOf(context);
      const authoritative = await authoritativeNow(context);
      if (after.currentState === 'revoked') {
        assert.equal(authoritative, false, `${label}: a revoked slot reported authority`);
      }
      await assertLogIntact(context, label);
    }
  });
});
