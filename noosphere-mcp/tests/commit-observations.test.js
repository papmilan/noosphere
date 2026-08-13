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
async function hooks(root, sub) {
  return execFileAsync(process.execPath, [CLI, 'hooks', sub, '--path', root], {
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
