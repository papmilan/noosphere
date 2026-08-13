import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { promisify } from 'node:util';

import { watchProject } from '../continuity/index.js';

const execFileAsync = promisify(execFile);
const temporary = [];

after(async () => Promise.all(temporary.map(directory =>
  fs.rm(directory, { recursive: true, force: true }))));

async function repository({ watchSubdirectory = false } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-watch-')));
  temporary.push(root);
  await execFileAsync('git', ['init', '--quiet'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'test'], { cwd: root });
  await fs.writeFile(path.join(root, 'file.txt'), 'one\n');
  await execFileAsync('git', ['add', 'file.txt'], { cwd: root });
  await execFileAsync('git', ['commit', '--quiet', '-m', 'first'], { cwd: root });
  // A watcher may legitimately be rooted below the repository top level:
  // `assertGitRepository` accepts anything inside the work tree, and the IDE
  // bridge registers scanned directories without normalizing to the git root.
  const watched = watchSubdirectory ? path.join(root, 'packages', 'app') : root;
  await fs.mkdir(path.join(watched, '.noosphere'), { recursive: true });
  await fs.writeFile(
    path.join(watched, '.noosphere', 'config.json'),
    JSON.stringify({
      project_id: 'watch-fixture',
      privacy: { checkpoint_content: 'metadata-only', share_journal: false },
      relayer_url: 'http://127.0.0.1:59999',
    }),
  );
  return watched;
}

// Captures console output for the duration of one watcher.
function captureWarnings() {
  const lines = [];
  const original = { warn: console.warn, log: console.log };
  console.warn = (...args) => lines.push(args.join(' '));
  console.log = () => {};
  return {
    lines,
    restore: () => Object.assign(console, original),
  };
}

describe('watching a root that goes away', () => {
  it('stops instead of retrying a vanished working directory forever', async () => {
    const root = await repository();
    const captured = captureWarnings();

    try {
      // 500ms poll: the interval is debounceMs/4 bounded to [500, 2000].
      const watching = watchProject(root, { debounceMs: 2_000, refreshMs: 60_000 });
      // Let the first poll run against a healthy repository.
      await new Promise((resolve) => setTimeout(resolve, 700));

      // The disk goes away underneath it. Node reports a spawn whose cwd is
      // missing as ENOENT on the command, which is why the manager log filled
      // with `spawn git ENOENT` while git was installed and working.
      await fs.rm(root, { recursive: true, force: true });

      await Promise.race([
        watching,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('watcher kept polling a vanished root')), 10_000)),
      ]);
    } finally {
      captured.restore();
    }

    const reachability = captured.lines.filter(line => line.includes('no longer reachable'));
    assert.equal(reachability.length, 1, `expected one reachability warning, got: ${captured.lines.join(' | ')}`);
    assert.match(reachability[0], /watch-fixture/);
    assert.match(reachability[0], /resumes automatically/);
    // The message must not blame git, which was installed and working the whole
    // time — that misdirection is the reason this took a log dive to find.
    assert.doesNotMatch(reachability[0], /spawn git|ENOENT/);
    // And it says it once rather than every poll.
    assert.equal(captured.lines.filter(line => /spawn git ENOENT/.test(line)).length, 0);
  });

  // Probing `root/.git` instead of the root made every subdirectory-rooted
  // watcher answer "unreachable", so the first ordinary background failure
  // stopped a perfectly healthy one — and because it exits 0 with the path
  // still there, the manager respawned it every five seconds with the restart
  // backoff bypassed.
  it('does not mistake a subdirectory root for a vanished disk', async () => {
    const watched = await repository({ watchSubdirectory: true });
    const captured = captureWarnings();
    let settled = false;

    try {
      const watching = watchProject(watched, { debounceMs: 2_000, refreshMs: 700 })
        .then(() => { settled = true; });
      // refreshContext against a dead relayer fails every cycle. The repository
      // is healthy and the directory is present, so this must only log.
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      assert.equal(settled, false, 'a healthy subdirectory watcher must not stop');
      process.emit('SIGTERM');
      await watching;
    } finally {
      captured.restore();
    }

    assert.equal(
      captured.lines.filter(line => line.includes('no longer reachable')).length,
      0,
      `a present directory must never be reported unreachable: ${captured.lines.join(' | ')}`,
    );
  });

  it('stops a subdirectory watcher when that directory itself goes away', async () => {
    const watched = await repository({ watchSubdirectory: true });
    const captured = captureWarnings();

    try {
      const watching = watchProject(watched, { debounceMs: 2_000, refreshMs: 60_000 });
      await new Promise((resolve) => setTimeout(resolve, 700));
      await fs.rm(watched, { recursive: true, force: true });
      await Promise.race([
        watching,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('watcher kept polling a vanished directory')), 10_000)),
      ]);
    } finally {
      captured.restore();
    }

    assert.equal(captured.lines.filter(line => line.includes('no longer reachable')).length, 1);
  });

  it('keeps watching when a poll fails for a reason that is not the root', async () => {
    const root = await repository();
    const captured = captureWarnings();
    let settled = false;

    try {
      const watching = watchProject(root, { debounceMs: 2_000, refreshMs: 700 })
        .then(() => { settled = true; });
      // refreshContext against an unreachable relayer fails every cycle; the
      // repository is fine, so the watcher must log and carry on rather than
      // treating any error as a vanished disk.
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      assert.equal(settled, false, 'an ordinary background failure must not stop the watcher');
      process.emit('SIGTERM');
      await watching;
    } finally {
      captured.restore();
    }

    assert.equal(
      captured.lines.filter(line => line.includes('no longer reachable')).length,
      0,
      'a reachable root must never be reported as unreachable',
    );
  });
});
