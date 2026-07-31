import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, describe, it } from 'node:test';
import { workspaceFingerprintHex } from '../continuity/acp/git-state.js';

const execFileAsync = promisify(execFile);
const tmpDirs = [];

after(async () => {
  await Promise.all(tmpDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

// realpath matters on macOS, where os.tmpdir() is a /var -> /private/var symlink
// and git reports the resolved path back.
async function dirtyRepository() {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'noosphere-git-locks-')));
  tmpDirs.push(dir);
  const git = (args) => execFileAsync('git', args, { cwd: dir });
  await git(['init', '--quiet', '.']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'Test']);
  // Enough content that refreshing the index takes long enough to observe.
  const file = path.join(dir, 'tracked.txt');
  await writeFile(file, Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n'));
  await git(['add', 'tracked.txt']);
  await git(['commit', '--quiet', '-m', 'init']);
  // Leave the tree dirty so status and diff both have real work to do.
  await appendFile(file, `\n${Array.from({ length: 400 }, (_, i) => `edit ${i}`).join('\n')}`);
  return dir;
}

describe('background git never takes .git/index.lock', () => {
  it('fingerprints a dirty repository without locking the index', async () => {
    const dir = await dirtyRepository();
    const lockPath = path.join(dir, '.git', 'index.lock');

    let observations = 0;
    const poller = setInterval(() => {
      if (existsSync(lockPath)) observations += 1;
    }, 1);

    try {
      for (let i = 0; i < 20; i += 1) {
        assert.match(await workspaceFingerprintHex(dir), /^[0-9a-f]{64}$/);
      }
    } finally {
      clearInterval(poller);
    }

    // Without --no-optional-locks this observes the lock thousands of times:
    // `git status` and `git diff` refresh the index and write it back, which
    // makes the every-2s watcher poll race the developer's own git commands.
    assert.equal(
      observations,
      0,
      `.git/index.lock was observed ${observations} times; background git must pass --no-optional-locks`,
    );
  });
});
