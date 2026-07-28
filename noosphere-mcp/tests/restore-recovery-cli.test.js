// SEC-05 Phase 4C, Finding 1 remediation — crash recovery in the production path.
//
// Every test here drives the REAL CLI as a subprocess. Nothing imports
// recovery.js to make recovery happen: if the production wiring is removed or
// reordered, these fail, which is the whole point. (recovery.js is imported for
// read-only assertions and for classifyLockLiveness, never to trigger a repair.)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { readApplyJournal } from '../continuity/internal/restore/apply-journal.js';
import {
  listApplyInProgressCandidates,
  markApplyInProgress,
  readCandidateState,
  stageRestoreCandidate,
} from '../continuity/internal/restore/candidate-store.js';
import { approveSlot } from '../continuity/internal/approval-service.js';
import {
  issueConfirmation,
  spendContext,
} from '../continuity/internal/restore/confirmation-store.js';
import { listRestoreCandidates } from '../continuity/internal/restore/candidate-store.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  classifyLockLiveness,
  reclaimAbandonedLock,
} from '../continuity/internal/restore/recovery.js';
import { stripComments } from './helpers/writer-surface.js';
import { createFormatV2Store } from '../continuity/internal/trust-format-v2.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(packageRoot, 'continuity', 'index.js');
const CRASH_CHILD = fileURLToPath(new URL('./helpers/restore-crash-child.mjs', import.meta.url));
const BOUNDARIES = [
  'prepared',
  'temporary-written',
  'destination-replaced',
  'receipt-committed',
  'consumed-marker-committed',
];
const REPLACED = new Set(['destination-replaced', 'receipt-committed', 'consumed-marker-committed']);

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

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-cli-recovery-home-'));
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-cli-recovery-project-'));
  temporary.push(home, projectRoot);
  await fs.mkdir(path.join(projectRoot, '.noosphere'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, '.noosphere', 'baseline.md'), 'before');
  const env = { NOOSPHERE_HOME: home, NOOSPHERE_OWNER_SCOPE: 'phase4c-owner' };
  const content = '# Noosphere project baseline\n\nafter\n';
  const staged = await stageRestoreCandidate({
    projectRoot,
    slot: 'baseline',
    env,
    ...ttyStreams(),
    recall: async () => ({ memories: [{ action_type: 'project-baseline', content }] }),
  });
  return {
    projectRoot,
    env,
    content,
    candidateId: staged.candidate.candidateId,
    destination: path.join(projectRoot, '.noosphere', 'baseline.md'),
  };
}

/** Runs the real CLI. stdin/stdout are pipes, so no interactive verb can proceed. */
function cli(context, args) {
  return spawnSync(process.execPath, [CLI, 'restore', ...args, '--path', context.projectRoot], {
    env: { ...process.env, ...context.env, NOOSPHERE_PROJECT_DIR: context.projectRoot },
    encoding: 'utf8',
    input: '',
    timeout: 300000,
  });
}

/** Crashes a genuine apply with SIGKILL at `boundary`, leaving the lock held. */
function crash(context, boundary) {
  const result = spawnSync(process.execPath, [CRASH_CHILD], {
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
  assert.equal(result.error, undefined, `crash child errored: ${result.error?.message}`);
  assert.ok(result.signal === 'SIGKILL' || result.status !== 0, 'child must die abruptly');
  return result;
}

async function stateOf(context) {
  const journal = await readApplyJournal({
    projectRoot: context.projectRoot,
    env: context.env,
    candidateId: context.candidateId,
  });
  const candidate = await readCandidateState({
    projectRoot: context.projectRoot,
    env: context.env,
    candidateId: context.candidateId,
  });
  return { journal, candidate, bytes: await fs.readFile(context.destination) };
}

describe('SEC-05 Phase 4C — crash recovery through the production CLI', () => {
  for (const boundary of BOUNDARIES) {
    it(`recovers a SIGKILL at ${boundary} through \`noosphere restore recover\``, async () => {
      const context = await fixture();
      crash(context, boundary);

      // The crash left a held lock. Nothing has been recovered yet.
      const store = createFormatV2Store({ env: context.env });
      const binding = await store.readProjectBinding(context.projectRoot);
      const held = await store.inspectLock(binding, 'baseline');
      assert.notEqual(held, null, 'a real crash must leave the slot lock held');
      assert.equal(classifyLockLiveness(held), 'abandoned');

      const recovered = cli(context, ['recover']);
      assert.equal(recovered.status, 0, `restore recover failed: ${recovered.stderr}`);
      assert.match(recovered.stdout, /no destination was replaced twice/);

      const after = await stateOf(context);
      assert.equal(after.journal.state, 'complete');
      assert.equal(after.journal.outcome, REPLACED.has(boundary) ? 'applied' : 'failed');
      assert.equal(after.candidate.state, 'consumed');
      assert.equal(
        after.bytes.toString('utf8'),
        REPLACED.has(boundary) ? context.content : 'before',
      );
      assert.equal(await store.inspectLock(binding, 'baseline'), null, 'the lock was not released');
      const temporaryPath = path.join(context.projectRoot, ...after.journal.temporaryPath.split('/'));
      await assert.rejects(fs.access(temporaryPath), 'the temporary file survived recovery');
    });
  }

  // MUTATION TARGET: "remove the production recovery call" and "move recovery
  // after new transaction creation". The apply verb runs recovery BEFORE
  // applyRestoreCandidate, so it converges the crashed transaction even though
  // the apply itself is then refused at the TTY gate. Portable: no PTY needed,
  // which is what lets this run on Windows too.
  for (const boundary of BOUNDARIES) {
    it(`converges a SIGKILL at ${boundary} before a new apply may begin`, async () => {
      const context = await fixture();
      crash(context, boundary);

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
    const before = await fs.readFile(context.destination);

    assert.equal(cli(context, ['recover']).status, 0);
    const after = await stateOf(context);
    assert.deepEqual(after.bytes, before);
    assert.equal(after.journal.state, 'complete');
    assert.equal(after.journal.outcome, 'applied');
  });

  it('leaves a destination changed after the committed replacement untouched', async () => {
    const context = await fixture();
    crash(context, 'destination-replaced');
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
});

describe('SEC-05 Phase 4C — hostile-review recovery findings', () => {
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

describe('SEC-05 Phase 4C — restore recovery lock policy', () => {
  // MUTATION TARGET: "delete a held lock unconditionally". Age is never a
  // reason; ownership and liveness are the only reasons.
  it('classifies liveness by process state alone, never by age or clock', () => {
    const live = { pid: process.pid, startedAt: new Date().toISOString() };
    assert.equal(classifyLockLiveness(live), 'live');
    // A PID that cannot exist is gone.
    assert.equal(classifyLockLiveness({ ...live, pid: 0x7ffffff }), 'abandoned');

    // HOSTILE REVIEW, finding 2: a lock whose startedAt is arbitrarily old, or
    // arbitrarily in the future, must not move the verdict at all. The previous
    // implementation declared a lock older than the machine's uptime abandoned,
    // which a forward clock jump turns into reclaiming a LIVE lock.
    for (const startedAt of [
      new Date(0).toISOString(),
      new Date(Date.now() - 365 * 86400_000).toISOString(),
      new Date(Date.now() + 365 * 86400_000).toISOString(),
      undefined,
      'not-a-date',
    ]) {
      assert.equal(
        classifyLockLiveness({ ...live, startedAt }),
        'live',
        `startedAt=${startedAt} changed a LIVE verdict`,
      );
    }

    // Only the PID shape can make it ambiguous.
    for (const broken of [{}, { pid: undefined }, { pid: -1 }, { pid: 0 }, { pid: 1.5 }, { pid: '1234' }]) {
      assert.equal(classifyLockLiveness(broken), 'ambiguous',
        `${JSON.stringify(broken)} must be ambiguous`);
    }
  });

  // HOSTILE REVIEW, finding 3: os.uptime() throws EPERM under some sandboxes
  // and container profiles. The classifier must not depend on it — or on any
  // other host call that can refuse.
  it('depends on no host call that can refuse', async () => {
    const source = stripComments(await fs.readFile(
      path.join(packageRoot, 'continuity/internal/restore/recovery.js'), 'utf8',
    ));
    assert.equal(/\bos\.uptime\s*\(/.test(source), false,
      'recovery reads os.uptime(), which throws EPERM under some sandboxes');
    assert.equal(/from 'node:os'/.test(source), false,
      'recovery imports node:os again — the liveness verdict must not depend on host state');
    // The classifier takes no options at all now, so nothing can steer it.
    assert.equal(classifyLockLiveness.length, 1, 'classifyLockLiveness regained a steerable parameter');
  });

  // HOSTILE REVIEW, finding 2: the liveness decision must not be steerable by a
  // caller-supplied clock, and there must be no clock in it to steer.
  it('exposes no clock or host seam the caller can steer', async () => {
    const source = stripComments(await fs.readFile(
      path.join(packageRoot, 'continuity/internal/restore/recovery.js'), 'utf8',
    ));
    const mentions = [...source.matchAll(/classifyLockLiveness\s*\(/g)];
    assert.equal(mentions.length, 3, 'unexpected classifyLockLiveness call sites');
    assert.equal(/classifyLockLiveness\([a-zA-Z]+,/.test(source), false,
      'a second argument was reintroduced to the liveness verdict');
    const live = { pid: process.pid, startedAt: new Date().toISOString() };
    assert.equal(classifyLockLiveness(live, { now: () => new Date(Date.now() + 4e10) }), 'live',
      'an injected clock changed the verdict');
  });

  it('refuses to reclaim a lock held by a live process', async () => {
    const context = await fixture();
    crash(context, 'destination-replaced');
    const store = createFormatV2Store({ env: context.env });
    const binding = await store.readProjectBinding(context.projectRoot);

    // Replace the dead crash lock with an authenticated lock minted by THIS
    // process, which is unambiguously alive.
    await fs.rm(store.lockPath(binding, 'baseline'), { force: true });
    const live = await store.acquireLock(binding, 'baseline');
    assert.equal(classifyLockLiveness(await store.inspectLock(binding, 'baseline')), 'live');

    const result = cli(context, ['recover']);
    assert.equal(result.status, 4, `expected a security refusal, got ${result.status}`);
    assert.match(result.stderr, /live process|different transaction/);
    // The competitor's lock survives untouched.
    assert.notEqual(await store.inspectLock(binding, 'baseline'), null);
    await live.release();
  });

  it('fails closed on a malformed, unauthenticated, or foreign lock', async () => {
    for (const [name, mutate] of [
      ['malformed', async (file) => fs.writeFile(file, 'not json at all')],
      ['unauthenticated', async (file) => {
        const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
        parsed.pid = 999999;
        await fs.writeFile(file, JSON.stringify(parsed));
      }],
      ['foreign', async (file) => {
        const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
        parsed.ownerScope = 'somebody-else';
        await fs.writeFile(file, JSON.stringify(parsed));
      }],
    ]) {
      const context = await fixture();
      crash(context, 'destination-replaced');
      const store = createFormatV2Store({ env: context.env });
      const binding = await store.readProjectBinding(context.projectRoot);
      const lockFile = store.lockPath(binding, 'baseline');
      await mutate(lockFile);

      const result = cli(context, ['recover']);
      assert.equal(result.status, 4, `${name}: expected a security refusal, got ${result.status}`);
      assert.match(result.stderr, /lock/i, `${name}: refusal did not name the lock`);
      // The unusable lock is left exactly as found — never deleted, never repaired.
      assert.notEqual(await fs.readFile(lockFile, 'utf8').catch(() => null), null,
        `${name}: recovery removed a lock it could not authenticate`);
    }
  });

  // HOSTILE REVIEW, finding 1: reclaiming by path alone lets recovery delete a
  // LIVE competitor's lock if that competitor cleared the dead one and took the
  // slot between the verdict and the removal. The reclaim must re-identify the
  // exact file it authenticated.
  it('refuses to reclaim a lock that was replaced after the verdict', async () => {
    const context = await fixture();
    crash(context, 'destination-replaced');
    const store = createFormatV2Store({ env: context.env });
    const binding = await store.readProjectBinding(context.projectRoot);
    const lockFile = store.lockPath(binding, 'baseline');

    // The dead lock is authenticated and abandoned...
    const dead = await store.inspectLock(binding, 'baseline');
    assert.equal(classifyLockLiveness(dead), 'abandoned');

    // ...and then a competitor replaces it with its own live lock, exactly as it
    // would in the verdict-to-removal window.
    await fs.rm(lockFile, { force: true });
    const competitor = await store.acquireLock(binding, 'baseline');
    const held = await store.inspectLock(binding, 'baseline');
    assert.equal(classifyLockLiveness(held), 'live', 'the competitor lock must be live');
    assert.notEqual(held.transactionId, dead.transactionId);

    const result = cli(context, ['recover']);
    assert.equal(result.status, 4, `expected a security refusal, got ${result.status}`);
    // The competitor's lock survives byte-for-byte.
    const survived = await store.inspectLock(binding, 'baseline');
    assert.notEqual(survived, null, 'recovery deleted a live competitor lock');
    assert.equal(survived.transactionId, held.transactionId);
    assert.equal(survived.mac, held.mac);
    await competitor.release();
  });

  // HOSTILE REVIEW, finding 1 — the reclamation race, isolated.
  //
  // The enclosing barrier rejects a foreign transactionId BEFORE the reclaim, so
  // driving this through the CLI cannot reach the window. This drives the
  // reclaim directly with a stale expectation, which is exactly the state the
  // barrier hands it when a competitor moves in the meantime.
  it('refuses to remove a lock that was replaced after the verdict', async () => {
    const context = await fixture();
    crash(context, 'destination-replaced');
    const store = createFormatV2Store({ env: context.env });
    const binding = await store.readProjectBinding(context.projectRoot);
    const lockFile = store.lockPath(binding, 'baseline');

    // What the barrier authenticated: a dead lock, plus its file identity.
    const dead = await store.inspectLock(binding, 'baseline');
    assert.equal(classifyLockLiveness(dead), 'abandoned');
    const deadStat = await fs.lstat(lockFile);
    const expected = {
      lock: dead,
      identity: { ino: deadStat.ino, dev: deadStat.dev, size: deadStat.size },
    };

    // A competitor clears the dead lock and takes the slot — the race window.
    await fs.rm(lockFile, { force: true });
    const competitor = await store.acquireLock(binding, 'baseline');
    const held = await store.inspectLock(binding, 'baseline');
    assert.equal(classifyLockLiveness(held), 'live');
    assert.notEqual(held.transactionId, dead.transactionId);

    await assert.rejects(
      reclaimAbandonedLock(store, binding, 'baseline', expected),
      (error) => error.code === 'ERR_RESTORE_OWNER_INTERVENTION_REQUIRED',
      'the reclaim removed a live competitor lock',
    );
    const survived = await store.inspectLock(binding, 'baseline');
    assert.notEqual(survived, null, 'a live competitor lock was deleted');
    assert.equal(survived.mac, held.mac);
    await competitor.release();
  });

  it('removes only the exact authenticated file, and reports an already-cleared lock', async () => {
    const context = await fixture();
    crash(context, 'destination-replaced');
    const store = createFormatV2Store({ env: context.env });
    const binding = await store.readProjectBinding(context.projectRoot);
    const lockFile = store.lockPath(binding, 'baseline');
    const dead = await store.inspectLock(binding, 'baseline');
    const stat = await fs.lstat(lockFile);
    const expected = {
      lock: dead,
      identity: { ino: stat.ino, dev: stat.dev, size: stat.size },
    };

    // A lock file recreated with identical BYTES but a new inode is still not
    // the file that was authenticated.
    const bytes = await fs.readFile(lockFile);
    await fs.rm(lockFile);
    await fs.writeFile(lockFile, bytes, { mode: 0o600 });
    await assert.rejects(
      reclaimAbandonedLock(store, binding, 'baseline', expected),
      (error) => error.code === 'ERR_RESTORE_OWNER_INTERVENTION_REQUIRED',
      'the reclaim accepted a different file with the same bytes',
    );

    // Cleared by someone else: nothing to remove, and no refusal either.
    await fs.rm(lockFile, { force: true });
    assert.equal(await reclaimAbandonedLock(store, binding, 'baseline', expected), false);

    // The genuine case still works.
    const fresh = await fixture();
    crash(fresh, 'destination-replaced');
    const freshStore = createFormatV2Store({ env: fresh.env });
    const freshBinding = await freshStore.readProjectBinding(fresh.projectRoot);
    const freshLock = await freshStore.inspectLock(freshBinding, 'baseline');
    const freshStat = await fs.lstat(freshStore.lockPath(freshBinding, 'baseline'));
    assert.equal(
      await reclaimAbandonedLock(freshStore, freshBinding, 'baseline', {
        lock: freshLock,
        identity: { ino: freshStat.ino, dev: freshStat.dev, size: freshStat.size },
      }),
      true,
    );
    assert.equal(await freshStore.inspectLock(freshBinding, 'baseline'), null);
  });

  it('does not touch a lock belonging to a different transaction', async () => {
    const context = await fixture();
    crash(context, 'destination-replaced');
    const store = createFormatV2Store({ env: context.env });
    const binding = await store.readProjectBinding(context.projectRoot);

    // A valid, authenticated, ABANDONED lock — but for another transaction.
    await fs.rm(store.lockPath(binding, 'baseline'), { force: true });
    const other = await store.acquireLock(binding, 'baseline');
    const raw = JSON.parse(await fs.readFile(store.lockPath(binding, 'baseline'), 'utf8'));
    assert.notEqual(raw.transactionId, undefined);

    const result = cli(context, ['recover']);
    assert.equal(result.status, 4);
    assert.match(result.stderr, /different transaction|live process/);
    await other.release();
  });

  it('does not expose recovery outside the restore CLI', async () => {
    // A public-surface guard local to this file, so a future change that makes
    // recovery reachable fails here as well as in the boundary suite.
    await assert.rejects(
      import('noosphere-continuity/continuity/internal/restore/recovery.js'),
      (error) => error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
    );
    const publicModule = await import('noosphere-continuity/trust-store');
    assert.equal('recoverRestoreTransactions' in publicModule, false);
  });
});
