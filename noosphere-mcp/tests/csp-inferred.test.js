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
import { refreshContext } from '../continuity/index.js';
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

async function fileExists(file) {
  return fs.access(file).then(() => true, () => false);
}

async function infer(root, field, value, basis = 'commit 8d1ba7a touched the parser') {
  return recordInferredField(root, field, value, { basis, now: '2026-08-13T00:00:00.000Z' });
}

// refreshContext loads project config; the bare fixture above has none.
async function contextProject() {
  const root = await repository();
  await fs.writeFile(
    path.join(root, '.noosphere', 'config.json'),
    JSON.stringify({ project_id: 'inferred-context', privacy: {} }),
  );
  return root;
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
    assert.equal(await fileExists(inferredStatePath(root)), true, 'a remaining guess keeps the file');

    assert.deepEqual(await clearInferredFields(root), ['current_task']);
    assert.deepEqual(await readInferredState(root), {});
    // An empty lane looks empty on disk, the way `journal discard` leaves
    // nothing behind, rather than leaving a husk with no fields in it.
    assert.equal(await fileExists(inferredStatePath(root)), false, 'the last guess takes the file with it');
    // And clearing again is a no-op rather than a failure on the missing file.
    assert.deepEqual(await clearInferredFields(root), []);

    // A file emptied by an older build carries no fields but still exists;
    // clearing cleans it up rather than requiring a hand-deletion.
    await fs.writeFile(
      inferredStatePath(root),
      JSON.stringify({ schema: 'noosphere.inferred-state', version: 1, fields: {} }),
    );
    assert.deepEqual(await clearInferredFields(root), []);
    assert.equal(await fileExists(inferredStatePath(root)), false, 'an inherited husk is removed too');
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

  // CLAUDE.md sends agents to `noosphere context --local-only` and
  // `.noosphere/state.json`. The lane rendered only in `noosphere state` and
  // `noosphere resume`, so it was invisible to every reader that follows the
  // documented protocol — and the spec's §5 criterion cannot ask whether
  // inference reaches the read path while it does not reach it at all.
  it('reaches the documented read path, quoted and labeled', async () => {
    const root = await contextProject();
    await infer(root, 'next_action', 'run the suite');

    const rendered = await refreshContext(root, { localOnly: true });

    assert.match(rendered, /## Inferred state \(untrusted guesses, NOT canonical\)/);
    assert.match(rendered, /^> next_action: run the suite \(inferred; basis: .+\)$/m);
    assert.match(rendered, /only when the owner runs `noosphere state promote`/);
    // Below the slots that can render as authoritative, with the other
    // untrusted data, so ordering alone never suggests authority.
    assert.ok(
      rendered.indexOf('## Inferred state') > rendered.indexOf('## Pinned master prompt'),
      'the inferred lane must render below anything that can be authoritative',
    );
  });

  it('says so plainly when the lane is empty', async () => {
    const rendered = await refreshContext(await contextProject(), { localOnly: true });

    assert.match(rendered, /## Inferred state \(untrusted guesses, NOT canonical\)/);
    assert.match(rendered, /No inferred values recorded\./);
  });

  it('neutralizes a hostile guess instead of letting it forge structure', async () => {
    const root = await contextProject();
    // CSP validation already refuses control characters, so a newline — and with
    // it a `## ` at column 0 — cannot reach the render at all. A bidi override
    // can: it is an ordinary code point to that check, and only the renderer
    // stops it reversing the text an owner reads before promoting.
    const override = String.fromCodePoint(0x202e);
    await infer(root, 'current_task', `ship ${override}daeh eht`);

    const rendered = await refreshContext(root, { localOnly: true });

    assert.equal(rendered.includes(override), false, 'bidi overrides must not survive');
    assert.match(rendered, /^> current_task: ship daeh eht \(inferred; basis: .+\)$/m);
    const headings = rendered.split('\n').filter((line) => line.startsWith('## '));
    assert.equal(
      headings.filter((line) => line.includes('daeh')).length,
      0,
      'a guess must not reach column 0',
    );
  });

  // The renderer used to carry its own sanitizer, weaker than the one
  // memory-safety.js registers for untrusted content. These three all reached
  // the render, and this is the text an owner reads immediately before deciding
  // whether to promote a guess into canonical state.
  it('strips the invisible code points its own sanitizer used to miss', async () => {
    const root = await contextProject();
    const zeroWidth = String.fromCodePoint(0x200b);
    // The TAG block is the interesting one: it carries readable ASCII that most
    // renderers show as nothing at all, so it hides text in plain sight.
    const tag = String.fromCodePoint(0xe0041);
    await infer(root, 'current_task', `ship${zeroWidth}it${tag}`);

    const rendered = await refreshContext(root, { localOnly: true });

    assert.equal(rendered.includes(zeroWidth), false, 'zero-width must not survive');
    assert.equal(rendered.includes(tag), false, 'TAG-block code points must not survive');
    assert.match(rendered, /^> current_task: shipit \(inferred; basis: .+\)$/m);
  });

  // A prefix bypass, not a cosmetic one. renderResumeSummary quotes the journal
  // excerpt per line after splitting on '\n', so a separator the reader's
  // renderer honours but the splitter does not puts everything after it at
  // column 0, outside every `> `. Collapsing separators to '\n' first is what
  // makes the split reach every line the renderer can produce.
  //
  // Scoped to renderResumeSummary on purpose: context.md's journal section comes
  // from formatLocalJournal in continuity/index.js, which neither quotes nor
  // normalizes — deliberately, since entries there keep their own `## ` headers.
  // That is a separate question and is recorded rather than changed here.
  it('quotes a journal line split by a separator that is not a newline', async () => {
    const root = await contextProject();
    const separator = String.fromCodePoint(0x2028);
    await fs.writeFile(
      path.join(root, '.noosphere', 'journal.md'),
      `# Journal\n\n## 2026-08-14T00:00:00.000Z — tester / note\n\nsafe${separator}## forged heading\n`,
    );

    const summary = await renderResumeSummary(root);

    assert.equal(summary.includes(separator), false, 'a line separator must not survive');
    const forged = summary.split('\n').filter((line) => line.includes('forged heading'));
    assert.equal(forged.length, 1);
    assert.ok(forged[0].startsWith('> '), `the forged heading escaped its quote: ${forged[0]}`);
  });

  it('refuses to promote without an interactive terminal', async () => {
    const root = await repository();
    await state(root, 'infer', 'next-action', 'run the suite', '--basis', 'the suite is red');

    const failure = await state(root, 'promote').then(() => null, error => error);

    assert.notEqual(failure, null, 'promote must refuse a non-interactive caller');
    assert.match(failure.stderr, /requires an interactive terminal/);
    // Refused before anything is printed: a scripted caller should not find the
    // proposal echoed into its log ahead of the refusal.
    assert.equal(failure.stdout, '');
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
