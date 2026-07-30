import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  BOUNDARIES,
  REPLACED,
  clearSlotLockAsOwner,
  cli,
  crash,
  fixture,
  stateOf,
} from './helpers/restore-recovery-cli-fixture.js';

describe('SEC-05 Phase 4C — crash recovery convergence and idempotence', () => {
  // MUTATION TARGET: "remove the production recovery call" and "move recovery
  // after new transaction creation". The apply verb runs recovery BEFORE
  // applyRestoreCandidate, so it converges the crashed transaction even though
  // the apply itself is then refused at the TTY gate. Portable: no PTY needed,
  // which is what lets this run on Windows too.
  for (const boundary of BOUNDARIES) {
    it(`converges a SIGKILL at ${boundary} before a new apply after owner lock removal`, async () => {
      const context = await fixture();
      crash(context, boundary);

      const blocked = cli(context, ['apply', context.candidateId]);
      assert.equal(blocked.status, 4);
      assert.match(blocked.stderr, /slot lock is present/);

      await clearSlotLockAsOwner(context);
      const attempted = cli(context, ['apply', context.candidateId]);
      // The apply is refused — piped stdin is not a terminal — but only after
      // recovery already ran.
      assert.equal(attempted.status, 4, `expected the TTY refusal, got: ${attempted.stderr}`);
      assert.match(attempted.stderr, /interactive terminal/);

      const after = await stateOf(context);
      assert.equal(after.journal.state, 'complete',
        'the crashed transaction was not recovered before the apply attempt');
      assert.equal(after.candidate.state, 'consumed');
      assert.equal(
        after.bytes.toString('utf8'),
        REPLACED.has(boundary) ? context.content : 'before',
      );
    });
  }

  it('never repeats a destination replacement across repeated CLI recovery', async () => {
    const context = await fixture();
    crash(context, 'destination-replaced');
    await clearSlotLockAsOwner(context);

    const first = cli(context, ['recover']);
    assert.equal(first.status, 0, first.stderr);
    const afterFirst = await fs.readFile(context.destination);
    assert.equal(afterFirst.toString('utf8'), context.content);
    const journalAfterFirst = (await stateOf(context)).journal;

    // Repeated recovery is byte-identical on disk AND on stdout: the second and
    // third runs observe a complete transaction and change nothing.
    const second = cli(context, ['recover']);
    const third = cli(context, ['recover']);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(third.status, 0, third.stderr);
    assert.equal(second.stdout, third.stdout);
    assert.match(second.stdout, /No restore transaction needed recovery\./);
    assert.deepEqual(await fs.readFile(context.destination), afterFirst);
    const journalAfterThird = (await stateOf(context)).journal;
    assert.equal(journalAfterThird.state, 'complete');
    assert.equal(journalAfterThird.stateEventHash, journalAfterFirst.stateEventHash,
      'recovery appended a second terminal journal fact');
  });

  it('converges a receipt-only partial state without a second replacement', async () => {
    const context = await fixture();
    crash(context, 'receipt-committed');
    await clearSlotLockAsOwner(context);
    const before = await fs.readFile(context.destination);
    assert.equal(before.toString('utf8'), context.content, 'the crash should have replaced already');

    assert.equal(cli(context, ['recover']).status, 0);
    const after = await stateOf(context);
    assert.deepEqual(after.bytes, before);
    assert.equal(after.journal.state, 'complete');
    assert.equal(after.journal.outcome, 'applied');
    assert.equal(after.candidate.state, 'consumed');
  });

  it('converges a consumed-marker-only partial state without a second replacement', async () => {
    const context = await fixture();
    crash(context, 'consumed-marker-committed');
    await clearSlotLockAsOwner(context);
    const before = await fs.readFile(context.destination);

    assert.equal(cli(context, ['recover']).status, 0);
    const after = await stateOf(context);
    assert.deepEqual(after.bytes, before);
    assert.equal(after.journal.state, 'complete');
    assert.equal(after.journal.outcome, 'applied');
  });
});
