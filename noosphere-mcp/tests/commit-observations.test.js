import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  observationsPath,
  readCommitObservations,
  recordCommitObservation,
} from '../continuity/acp/commit-observations.js';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../continuity/index.js', import.meta.url));
const temporary = [];

// Drives the real CLI. `--path` is not optional here: the CLI resolves its
// project directory as --path > NOOSPHERE_PROJECT_DIR > INIT_CWD > cwd, and npm
// sets INIT_CWD, so under `npm test` a cwd-only invocation would operate on the
// checkout instead of this fixture — installing a hook into the real repository
// and reporting success. NOOSPHERE_HOME is redirected for the same reason.
async function hooks(root, sub, ...args) {
  return execFileAsync(process.execPath, [CLI, 'hooks', sub, ...args, '--path', root], {
    cwd: root,
    env: { ...process.env, NOOSPHERE_HOME: path.join(root, 'home') },
  });
}

after(async () => Promise.all(temporary.map(directory =>
  fs.rm(directory, { recursive: true, force: true }))));

async function git(root, args) {
  return execFileAsync('git', args, { cwd: root });
}

async function repository({ commit = true } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-observe-')));
  temporary.push(root);
  await git(root, ['init', '--quiet']);
  await git(root, ['config', 'user.email', 'test@example.com']);
  await git(root, ['config', 'user.name', 'test']);
  await fs.mkdir(path.join(root, '.noosphere'), { recursive: true });
  if (commit) {
    await fs.writeFile(path.join(root, 'file.txt'), 'one\n');
    await git(root, ['add', 'file.txt']);
    await git(root, ['commit', '--quiet', '-m', 'first']);
  }
  return root;
}

describe('commit observations', () => {
  it('records the measured position and asserts no intent', async () => {
    const root = await repository();
    const observation = await recordCommitObservation(root, '2026-08-12T00:00:00.000Z');

    assert.match(observation.head, /^[0-9a-f]{40}$/);
    assert.equal(observation.source, 'git-hook');
    assert.equal(observation.dirty, false);
    // The whole point of a separate record type: a hook has nobody to state an
    // intent, so the observation carries none. If a cursor, step, or target
    // file ever appears here, something is fabricating goals from telemetry.
    for (const forbidden of ['cursor', 'steps', 'step_id', 'status', 'target', 'next_action']) {
      assert.equal(forbidden in observation, false, `observation must not assert ${forbidden}`);
    }
  });

  it('skips an empty repository instead of failing', async () => {
    const root = await repository({ commit: false });
    assert.equal(await recordCommitObservation(root, '2026-08-12T00:00:00.000Z'), null);
    assert.deepEqual(await readCommitObservations(root), []);
  });

  it('appends across commits and does not double-record one position', async () => {
    const root = await repository();
    await recordCommitObservation(root, '2026-08-12T00:00:00.000Z');
    // Same HEAD, same tree: a re-run of the hook, not a second event.
    await recordCommitObservation(root, '2026-08-12T00:00:01.000Z');
    assert.equal((await readCommitObservations(root)).length, 1);

    await fs.writeFile(path.join(root, 'file.txt'), 'two\n');
    await git(root, ['commit', '--quiet', '-am', 'second']);
    await recordCommitObservation(root, '2026-08-12T00:00:02.000Z');

    const observations = await readCommitObservations(root);
    assert.equal(observations.length, 2);
    assert.notEqual(observations[0].head, observations[1].head);
    // The fingerprint covers UNCOMMITTED state, so two clean trees hash alike
    // even at different commits. That is why deduplication has to compare the
    // head as well — on the fingerprint alone, every clean commit would look
    // like a repeat of the previous one and never be recorded.
    assert.equal(
      observations[0].workspace_fingerprint,
      observations[1].workspace_fingerprint,
    );
  });

  it('installs an executable post-commit hook and is idempotent', async () => {
    const root = await repository();
    await hooks(root, 'install');
    const hook = path.join(root, '.git', 'hooks', 'post-commit');
    // Windows has no meaningful executable bit and Git for Windows runs hooks
    // through sh regardless, so this is asserted only where it decides whether
    // the hook runs at all.
    if (process.platform !== 'win32') {
      const details = await fs.stat(hook);
      assert.equal(Boolean(details.mode & 0o100), true, 'hook must be executable');
    }
    const body = await fs.readFile(hook, 'utf8');
    assert.match(body, /noosphere observe --quiet --source git-hook/);
    // Failure must be invisible: git ignores the exit status anyway, and a line
    // printed on every commit is what gets a hook deleted.
    assert.match(body, />\/dev\/null 2>&1 \|\| true/);

    const second = await hooks(root, 'install');
    assert.match(second.stdout, /Already installed/);
  });

  // The suite used to assert only the hook file's *text*, so nothing ever let
  // git run it — which is how it shipped resolving the wrong project. npm
  // exports INIT_CWD to every lifecycle script, and the CLI reads it, so a
  // commit made from any `npm run …` recorded into whatever directory npm was
  // started from rather than into the repository being committed to.
  it('records into its own repository even when INIT_CWD names another one', async () => {
    const mine = await repository();
    const elsewhere = await repository();
    await hooks(mine, 'install');

    // The installed hook invokes bare `noosphere`, which is not on PATH here.
    // Substitute the interpreter and script path only — every argument,
    // including the `--path` under test, stays exactly as installed.
    const hook = path.join(mine, '.git', 'hooks', 'post-commit');
    const installed = await fs.readFile(hook, 'utf8');
    assert.match(installed, /--path "\$\(git rev-parse --show-toplevel\)"/);
    await fs.writeFile(
      hook,
      installed.replace(/^noosphere /m, `"${process.execPath}" "${CLI}" `),
      { mode: 0o755 },
    );

    await fs.writeFile(path.join(mine, 'file.txt'), 'two\n');
    await execFileAsync('git', ['commit', '--quiet', '-am', 'second'], {
      cwd: mine,
      // Exactly what npm exports when a commit is made from `npm run …`.
      env: { ...process.env, INIT_CWD: elsewhere, NOOSPHERE_HOME: path.join(mine, 'home') },
    });

    const head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: mine })).stdout.trim();
    const observed = await readCommitObservations(mine);
    assert.deepEqual(
      await readCommitObservations(elsewhere),
      [],
      'a commit here must not be recorded as a position over there',
    );
    assert.equal(observed.length, 1, 'the committed repository must get the observation');
    assert.equal(observed[0].head, head);
  });

  // The gap this closes was measured on the noosphere repository itself: the two
  // most recent commits on `main` were a squash and a merge created on GitHub,
  // and neither had an observation, because a commit made on a forge and pulled
  // down runs no post-commit hook here. Asserted by actually pulling rather than
  // by reading the hook body, for the reason the INIT_CWD test above records —
  // a text assertion never lets git run the thing.
  it('records a commit that arrived by pull rather than being made here', async () => {
    const upstream = await repository();
    const local = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-pull-')));
    temporary.push(local);
    await execFileAsync('git', ['clone', '--quiet', upstream, local]);
    await git(local, ['config', 'user.email', 'test@example.com']);
    await git(local, ['config', 'user.name', 'test']);
    await fs.mkdir(path.join(local, '.noosphere'), { recursive: true });
    await hooks(local, 'install');

    // Same substitution as the INIT_CWD test: bare `noosphere` is not on PATH
    // here, so only the command is replaced and every installed argument stays.
    const hook = path.join(local, '.git', 'hooks', 'post-merge');
    const installed = await fs.readFile(hook, 'utf8');
    await fs.writeFile(
      hook,
      installed.replace(/^noosphere /m, `"${process.execPath}" "${CLI}" `),
      { mode: 0o755 },
    );

    // Stands in for the squash or merge commit a forge writes: a commit this
    // machine never made, reaching the working tree only through a pull.
    await fs.writeFile(path.join(upstream, 'file.txt'), 'from the forge\n');
    await git(upstream, ['commit', '--quiet', '-am', 'landed upstream']);
    const head = (await git(upstream, ['rev-parse', 'HEAD'])).stdout.trim();

    await execFileAsync('git', ['pull', '--quiet'], {
      cwd: local,
      env: { ...process.env, NOOSPHERE_HOME: path.join(local, 'home') },
    });

    assert.equal(
      (await git(local, ['rev-parse', 'HEAD'])).stdout.trim(),
      head,
      'the pull must have brought the upstream commit down',
    );
    const observed = await readCommitObservations(local);
    assert.ok(
      observed.some((entry) => entry.head === head),
      `pulled commit ${head.slice(0, 12)} left no observation: ${JSON.stringify(observed)}`,
    );
  });

  it('repairs a hook it wrote before the project path was pinned', async () => {
    const root = await repository();
    await hooks(root, 'install');
    const hook = path.join(root, '.git', 'hooks', 'post-commit');
    const current = await fs.readFile(hook, 'utf8');
    // An older body: ours by marker, but missing --path and therefore recording
    // into whatever INIT_CWD names. A developer has no reason to suspect the
    // file needs replacing, so reinstalling has to repair it.
    await fs.writeFile(hook, current.replace(/ --path "[^"]*"/, ''), { mode: 0o755 });

    const result = await hooks(root, 'install');

    assert.match(result.stdout, /Updated/);
    assert.match(await fs.readFile(hook, 'utf8'), /--path "\$\(git rev-parse --show-toplevel\)"/);
  });

  it('will not install inference without being told which model', async () => {
    const root = await repository();

    const noModel = await hooks(root, 'install', '--infer').then(() => null, error => error);
    assert.notEqual(noModel, null, '--infer must not pick a model on its own');
    assert.match(noModel.stderr, /--infer requires --model/);
    // The measurement is in the error because the choice is not arbitrary: the
    // largest model tested was the worst, and a coder model is the wrong tool.
    assert.match(noModel.stderr, /CODER model is the wrong tool/);

    const noInfer = await hooks(root, 'install', '--model', 'gemma3:4b')
      .then(() => null, error => error);
    assert.notEqual(noInfer, null, '--model alone must not read as a request to infer');
    assert.match(noInfer.stderr, /--model only means something with --infer/);

    assert.equal(
      await fs.stat(path.join(root, '.git', 'hooks', 'post-commit')).catch(() => null),
      null,
      'a refused install must leave no hook behind',
    );
  });

  // The claim under test is the shell idiom, not the model: `... </dev/null
  // >/dev/null 2>&1 &`. git waits for the hook, and inference measured 23-60s
  // per commit, so getting this wrong hangs every commit — which is exactly how
  // §4.4 says a hook earns deletion. Substituting a sleep for the model keeps
  // the installed redirect-and-background tail intact and lets this run
  // anywhere, with no Ollama and no model download in CI.
  it('installs an inference line that cannot delay a commit', async () => {
    const root = await repository();
    await hooks(root, 'install', '--infer', '--model', 'gemma3:4b');
    const hook = path.join(root, '.git', 'hooks', 'post-commit');
    const installed = await fs.readFile(hook, 'utf8');

    assert.match(installed, /noosphere infer --quiet --model gemma3:4b/);
    assert.match(installed, /--path "\$\(git rev-parse --show-toplevel\)"/);
    // Observe stays in the foreground: the drift check and journal drafts read
    // what it writes, so it has to be finished before the commit returns.
    assert.ok(
      installed.indexOf('noosphere observe') < installed.indexOf('noosphere infer'),
      'observe must run before inference is spawned',
    );

    const marker = path.join(root, 'inference-finished');
    await fs.writeFile(
      hook,
      // Only the COMMAND is substituted; the redirect-and-background tail the
      // CLI installed is kept verbatim, because that tail is the thing under
      // test. Replacing the whole line would supply the `&` from here and pass
      // whatever the CLI wrote — which it did, until dropping the `&` from the
      // installed line failed to turn this red.
      installed.replace(
        /^noosphere infer .*?(?= <\/dev\/null)/m,
        `sh -c 'sleep 3; : > "${marker}"'`,
      ),
      { mode: 0o755 },
    );

    await fs.writeFile(path.join(root, 'file.txt'), 'two\n');
    const startedAt = Date.now();
    await execFileAsync('git', ['commit', '--quiet', '-am', 'second'], {
      cwd: root,
      env: { ...process.env, NOOSPHERE_HOME: path.join(root, 'home') },
    });
    const elapsed = Date.now() - startedAt;

    assert.ok(elapsed < 2_000, `commit waited ${elapsed}ms on a backgrounded 3s job`);
    // And it really is still running rather than killed with the hook: a
    // detachment that silently drops the work would pass the timing assertion
    // above on its own.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (await fs.stat(marker).then(() => true, () => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(
      await fs.stat(marker).then(() => true, () => false),
      'the backgrounded job must survive the hook exiting',
    );
  });

  it('refuses to overwrite or remove a hook it did not write', async () => {
    const root = await repository();
    const hook = path.join(root, '.git', 'hooks', 'post-commit');
    const mine = '#!/bin/sh\necho mine\n';
    await fs.writeFile(hook, mine, { mode: 0o755 });

    const install = await hooks(root, 'install').then(() => null, error => error);
    assert.notEqual(install, null, 'install must refuse a foreign hook');
    assert.match(install.stderr, /Refusing to overwrite/);

    const uninstall = await hooks(root, 'uninstall').then(() => null, error => error);
    assert.notEqual(uninstall, null, 'uninstall must refuse a foreign hook');
    assert.match(uninstall.stderr, /not installed by Noosphere/);

    assert.equal(await fs.readFile(hook, 'utf8'), mine, 'foreign hook must be untouched');
  });

  it('keeps its telemetry out of git in a project that never gitignored it', async () => {
    const root = await repository();
    await recordCommitObservation(root, '2026-08-13T00:00:00.000Z');

    // The fixture has no .gitignore at all, which is the situation in every
    // project except the one this feature was developed in: installing the hook
    // there used to leave an untracked file after the first commit.
    const visible = async () => {
      const { stdout } = await execFileAsync(
        'git',
        ['status', '--porcelain=v1', '--untracked-files=all'],
        { cwd: root },
      );
      return /commit-observations\.json/.test(stdout);
    };
    assert.equal(await visible(), false);

    // And a file left by an older build stays hidden, which the writing path
    // alone could not do: every later run on an unchanged position dedupes and
    // returns before any write.
    await fs.rm(path.join(root, '.git', 'info', 'exclude'));
    assert.equal(await visible(), true, 'precondition: without the exclude it is visible');
    assert.deepEqual(
      await recordCommitObservation(root, '2026-08-13T00:00:01.000Z'),
      (await readCommitObservations(root)).at(-1),
      'an unchanged position is a repeat observation, not a new one',
    );
    assert.equal(await visible(), false, 'a duplicate observation still refreshes the exclude');
  });

  it('survives a corrupt telemetry file rather than failing a read', async () => {
    const root = await repository();
    await recordCommitObservation(root, '2026-08-12T00:00:00.000Z');
    await fs.writeFile(observationsPath(root), '{not json');

    assert.deepEqual(await readCommitObservations(root), []);
    // And the next commit rebuilds it.
    await fs.writeFile(path.join(root, 'file.txt'), 'three\n');
    await git(root, ['commit', '--quiet', '-am', 'third']);
    assert.notEqual(await recordCommitObservation(root, '2026-08-12T00:00:03.000Z'), null);
    assert.equal((await readCommitObservations(root)).length, 1);
  });
});
