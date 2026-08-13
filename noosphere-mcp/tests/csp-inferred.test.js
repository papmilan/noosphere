import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  clearInferredFields,
  inferredDigest,
  inferredStatePath,
  promoteInferredFields,
  promotionPhrase,
  readInferredState,
  recordInferredField,
} from '../continuity/csp/inferred.js';
import { loadState } from '../continuity/csp/storage.js';
import { renderResumeSummary } from '../continuity/csp/summary.js';
import { transitionState } from '../continuity/csp/transitions.js';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../continuity/index.js', import.meta.url));
const temporary = [];

// See commit-observations.test.js: `--path` is not optional, because npm sets
// INIT_CWD and a cwd-only invocation would transition the checkout's own state.
async function state(root, ...args) {
  return execFileAsync(process.execPath, [CLI, 'state', ...args, '--path', root], {
    cwd: root,
    env: { ...process.env, NOOSPHERE_HOME: path.join(root, 'home') },
  });
}

after(async () => Promise.all(temporary.map(directory =>
  fs.rm(directory, { recursive: true, force: true }))));

async function repository() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-inferred-')));
  temporary.push(root);
  await execFileAsync('git', ['init', '--quiet'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'test'], { cwd: root });
  await fs.mkdir(path.join(root, '.noosphere'), { recursive: true });
  await fs.writeFile(path.join(root, 'file.txt'), 'one\n');
  await execFileAsync('git', ['add', 'file.txt'], { cwd: root });
  await execFileAsync('git', ['commit', '--quiet', '-m', 'first'], { cwd: root });
  return root;
}

async function infer(root, field, value, basis = 'commit 8d1ba7a touched the parser') {
  return recordInferredField(root, field, value, { basis, now: '2026-08-13T00:00:00.000Z' });
}

describe('inferred CSP state', () => {
  it('records a guess without touching tracked CSP', async () => {
    const root = await repository();
    await transitionState(root, { type: 'set', changes: { current_task: 'owner task' } });

    await infer(root, 'current_task', 'guessed task');

    const fields = await readInferredState(root);
    assert.equal(fields.current_task.value, 'guessed task');
    assert.equal(fields.current_task.source, 'inferred');
    // The whole point of the separate file: the canonical value is untouched.
    assert.equal((await loadState(root)).current_task, 'owner task');
  });

  it('refuses a value CSP itself would reject', async () => {
    const root = await repository();

    await assert.rejects(infer(root, 'status', 'almost-done'), /not valid CSP v1 content/);
    await assert.rejects(infer(root, 'current_task', 'x'.repeat(1001)), /not valid CSP v1 content/);
    await assert.rejects(infer(root, 'invented_field', 'x'), /not an inferable CSP v1 field/);
    // A guess nobody can review at promotion time is not worth storing.
    await assert.rejects(
      recordInferredField(root, 'next_action', 'ship it', { basis: '', now: '2026-08-13T00:00:00.000Z' }),
      /basis is required/,
    );
    assert.deepEqual(await readInferredState(root), {});
  });

  it('cannot express owner provenance, however the file is written', async () => {
    const root = await repository();
    await infer(root, 'next_action', 'run the suite');
    // Hand-forging `source: owner` in the untrusted file must not produce an
    // owner-authored value: the boundary is the file, not the field.
    const forged = JSON.parse(await fs.readFile(inferredStatePath(root), 'utf8'));
    forged.fields.next_action.source = 'owner';
    await fs.writeFile(inferredStatePath(root), JSON.stringify(forged));

    const fields = await readInferredState(root);
    assert.equal(fields.next_action.source, 'inferred');
    assert.equal(await loadState(root), null);
  });

  it('promotes only what the owner confirmed, then drops it', async () => {
    const root = await repository();
    await infer(root, 'current_task', 'wire the promotion path');
    await infer(root, 'next_action', 'run the suite');

    let shown;
    const result = await promoteInferredFields({
      root,
      fields: ['next_action'],
      confirm: (details) => {
        shown = details;
        return true;
      },
    });

    assert.equal(shown.phrase, promotionPhrase(inferredDigest({ next_action: 'run the suite' })));
    assert.deepEqual(result.promoted, ['next_action']);
    const promotedState = await loadState(root);
    assert.equal(promotedState.next_action, 'run the suite');
    assert.equal(promotedState.current_task, null, 'an unconfirmed guess must not ride along');

    const remaining = await readInferredState(root);
    assert.equal('next_action' in remaining, false, 'a promoted guess is consumed');
    assert.equal(remaining.current_task.value, 'wire the promotion path');
  });

  it('changes the phrase when the values change', async () => {
    const root = await repository();
    await infer(root, 'next_action', 'run the suite');
    const first = inferredDigest({ next_action: 'run the suite' });
    await infer(root, 'next_action', 'run the suite twice');

    let phrase;
    await promoteInferredFields({
      root,
      confirm: (details) => {
        phrase = details.phrase;
        return false;
      },
    }).catch(() => undefined);

    assert.notEqual(phrase, promotionPhrase(first));
    assert.equal(phrase, promotionPhrase(inferredDigest({ next_action: 'run the suite twice' })));
  });

  it('writes nothing when promotion is declined and keeps the guess', async () => {
    const root = await repository();
    await infer(root, 'current_task', 'guessed task');

    await assert.rejects(
      promoteInferredFields({ root, confirm: () => false }),
      /Promotion was not confirmed/,
    );

    assert.equal(await loadState(root), null);
    assert.equal((await readInferredState(root)).current_task.value, 'guessed task');
  });

  it('still enforces CSP transition rules on promotion', async () => {
    const root = await repository();
    await transitionState(root, { type: 'set', changes: { status: 'in-progress' } });
    await transitionState(root, { type: 'set', changes: { status: 'done' } });
    await infer(root, 'status', 'in-progress');

    // Promotion is a source of proposals, not a way around the state machine:
    // leaving `done` still requires an explicit reopen.
    await assert.rejects(
      promoteInferredFields({ root, confirm: () => true }),
      /requires an explicit reopen/,
    );
    assert.equal((await loadState(root)).status, 'done');
    assert.equal((await readInferredState(root)).status.value, 'in-progress');
  });

  it('drops guesses on request', async () => {
    const root = await repository();
    await infer(root, 'current_task', 'guessed task');
    await infer(root, 'next_action', 'run the suite');

    assert.deepEqual(await clearInferredFields(root, ['next_action']), ['next_action']);
    assert.deepEqual(Object.keys(await readInferredState(root)), ['current_task']);
    assert.deepEqual(await clearInferredFields(root), ['current_task']);
    assert.deepEqual(await readInferredState(root), {});
  });

  it('labels both lanes in the resume summary', async () => {
    const root = await repository();
    await transitionState(root, { type: 'set', changes: { current_task: 'owner task' } });
    await infer(root, 'next_action', 'run the suite');

    const summary = await renderResumeSummary(root);

    assert.match(summary, /Current task: owner task \(owner\)/);
    assert.match(summary, /Inferred, NOT canonical/);
    // Quoted, like the journal excerpt: a reader must not mistake it for state.
    assert.match(summary, /^> next_action: run the suite \(inferred; basis: .+\)$/m);
  });

  it('refuses to promote without an interactive terminal', async () => {
    const root = await repository();
    await state(root, 'infer', 'next-action', 'run the suite', '--basis', 'the suite is red');

    const failure = await state(root, 'promote').then(() => null, error => error);

    assert.notEqual(failure, null, 'promote must refuse a non-interactive caller');
    assert.match(failure.stderr, /requires an interactive terminal/);
    assert.equal(await loadState(root), null, 'nothing may be adopted without confirmation');
    assert.equal((await readInferredState(root)).next_action.value, 'run the suite');
  });

  it('records and clears a guess through the CLI without a terminal', async () => {
    const root = await repository();
    // Deliberately no TTY: an agent must be able to record a guess, because
    // recording one grants nothing.
    const recorded = await state(root, 'infer', 'current-task', 'guessed task', '--basis', 'HEAD moved');
    assert.match(recorded.stdout, /not canonical/);

    const shown = await state(root, 'inferred', '--json');
    const parsed = JSON.parse(shown.stdout);
    assert.equal(parsed.source, 'inferred');
    assert.equal(parsed.fields.current_task.value, 'guessed task');

    const cleared = await state(root, 'inferred', 'clear', 'current-task');
    assert.match(cleared.stdout, /Cleared inferred current_task/);
    assert.deepEqual(await readInferredState(root), {});
  });

  it('keeps inferred state out of git in every project', async () => {
    const root = await repository();
    await state(root, 'infer', 'next-action', 'run the suite', '--basis', 'the suite is red');

    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=all'],
      { cwd: root },
    );
    assert.doesNotMatch(stdout, /inferred-state\.json/);
  });
});
