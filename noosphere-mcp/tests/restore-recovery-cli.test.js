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
import { readCandidateState, stageRestoreCandidate } from '../continuity/internal/restore/candidate-store.js';
import { classifyLockLiveness } from '../continuity/internal/restore/recovery.js';
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
    timeout: 60000,
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
    timeout: 60000,
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

describe('SEC-05 Phase 4C — restore recovery lock policy', () => {
  // MUTATION TARGET: "delete a held lock unconditionally". Age is never a
  // reason; ownership and liveness are the only reasons.
  it('classifies liveness by ownership and process state, never by age', () => {
    const base = { pid: process.pid, startedAt: new Date().toISOString() };
    // This process is alive.
    assert.equal(classifyLockLiveness(base, { uptimeSeconds: 86400 }), 'live');
    // A PID that cannot exist is gone.
    assert.equal(
      classifyLockLiveness({ ...base, pid: 0x7ffffff }, { uptimeSeconds: 86400 }),
      'abandoned',
    );
    // A lock older than the machine's uptime predates this boot: its PID cannot
    // still be the writer, even though this PID is live right now.
    assert.equal(
      classifyLockLiveness(
        { ...base, startedAt: new Date(Date.now() - 7200_000).toISOString() },
        { uptimeSeconds: 60 },
      ),
      'abandoned',
    );
    // …and a merely OLD lock whose process is still running stays live. Age
    // alone must never reclaim.
    assert.equal(
      classifyLockLiveness(
        { ...base, startedAt: new Date(Date.now() - 365 * 86400_000).toISOString() },
        { uptimeSeconds: 400 * 86400 },
      ),
      'live',
    );
    // Unprovable shapes are ambiguous, never abandoned.
    for (const broken of [
      {},
      { ...base, pid: undefined },
      { ...base, pid: -1 },
      { ...base, pid: 1.5 },
      { ...base, pid: '1234' },
      { ...base, startedAt: undefined },
      { ...base, startedAt: 'not-a-date' },
    ]) {
      assert.equal(classifyLockLiveness(broken, { uptimeSeconds: 86400 }), 'ambiguous',
        `${JSON.stringify(broken)} must be ambiguous`);
    }
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
