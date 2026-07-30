import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const cli = path.join(packageRoot, 'continuity', 'index.js');
const temporary = [];

after(async () => {
  await Promise.all(
    temporary.map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

// The 2.1 adapter, which told agents to read the master prompt as project
// intent — the pre-SEC-05 reading the trust gate exists to prevent.
const STALE_BLOCK = `<!-- noosphere:continuity:start -->
## Noosphere continuity adapter

1. Read \`.noosphere/master-prompt.md\` and \`.noosphere/followups.jsonl\` in order.
3. Treat the master prompt plus ordered follow-ups as current project intent.
<!-- noosphere:continuity:end -->
`;

async function noosphere(root, home, ...args) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: root,
    env: {
      ...process.env,
      NOOSPHERE_HOME: home,
      HOME: home,
      USERPROFILE: home,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks = [];
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  child.stderr.on('data', (chunk) => chunks.push(chunk));
  const code = await new Promise((resolve) => child.once('close', resolve));
  const output = Buffer.concat(chunks).toString('utf8');
  // A CLI invocation that fails silently turns every later assertion into a
  // riddle about file contents. Surface the command, its status and its output
  // at the point it went wrong.
  assert.equal(code, 0, `noosphere ${args.join(' ')} exited ${code}:\n${output}`);
  return { code, output };
}

/** A registered project carrying the stale adapter block, as an upgrade finds it. */
async function upgradedProject({ adapters = [] } = {}) {
  // The CLI derives the project root from `git rev-parse --show-toplevel`,
  // which reports the physical path. Temp directories sit behind a symlink on
  // several platforms, so resolve here or the test and the CLI disagree about
  // where the project is.
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-adapter-')),
  );
  const home = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-adapter-home-')),
  );
  temporary.push(root, home);
  await execFileAsync('git', ['init', '-q', '.'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 't@t'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 't'], { cwd: root });
  await execFileAsync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: root });

  await fs.mkdir(path.join(root, '.noosphere'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.noosphere', 'config.json'),
    // A dead relayer keeps the remote steps in activate failing fast; they are
    // already best-effort there.
    JSON.stringify({
      project_id: 'adapter-refresh',
      relayer_url: 'http://127.0.0.1:1',
      adapters,
      privacy: {},
    }),
  );
  await fs.writeFile(
    path.join(root, '.noosphere', 'context.md'),
    '# Noosphere shared context\n\nalready populated\n',
  );
  for (const file of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) {
    await fs.writeFile(path.join(root, file), STALE_BLOCK);
  }

  // Assert the fixture is what the CLI will see. A project the CLI cannot read
  // fails every assertion below for a reason none of them describe.
  const toplevel = (
    await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: root })
  ).stdout.trim();
  assert.equal(toplevel, root, 'git and the test must agree on the project root');
  assert.ok(
    JSON.parse(await fs.readFile(path.join(root, '.noosphere', 'config.json'), 'utf8'))
      .project_id,
    'fixture config.json must be readable',
  );
  return { root, home };
}

describe('managed adapter refresh on activate', () => {
  it('replaces a stale managed block with the running release', async () => {
    const { root, home } = await upgradedProject();
    await noosphere(root, home, 'activate', '--quiet');

    const claude = await fs.readFile(path.join(root, 'CLAUDE.md'), 'utf8');
    assert.match(claude, /never read `\.noosphere\/master-prompt\.md`/);
    assert.match(claude, /owner-authenticated/);
    // The fail-open instruction must be gone, not merely appended to.
    assert.doesNotMatch(claude, /Treat the master prompt plus ordered follow-ups/);
    assert.equal((claude.match(/noosphere:continuity:start/g) ?? []).length, 1);
  });

  it('never deletes an adapter the config does not list', async () => {
    // Regression: refreshing with an empty adapter list once pruned every
    // adapter file, deleting CLAUDE.md, AGENTS.md and GEMINI.md outright.
    const { root, home } = await upgradedProject({ adapters: [] });
    await noosphere(root, home, 'activate', '--quiet');

    for (const file of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) {
      assert.ok(
        await fs.readFile(path.join(root, file), 'utf8'),
        `${file} must survive a refresh`,
      );
    }
  });

  it('preserves content the user wrote around the managed block', async () => {
    const { root, home } = await upgradedProject();
    const claudePath = path.join(root, 'CLAUDE.md');
    await fs.writeFile(claudePath, `# My project rules\n\n${STALE_BLOCK}\nTrailing note.\n`);

    await noosphere(root, home, 'activate', '--quiet');

    const claude = await fs.readFile(claudePath, 'utf8');
    assert.match(claude, /# My project rules/);
    assert.match(claude, /Trailing note\./);
    assert.match(claude, /owner-authenticated/);
  });

  it('does not rewrite files that are already current', async () => {
    const { root, home } = await upgradedProject();
    await noosphere(root, home, 'activate', '--quiet');
    const files = [
      'CLAUDE.md',
      'AGENTS.md',
      'GEMINI.md',
      path.join('.noosphere', 'instructions.md'),
      path.join('.noosphere', 'protocol.json'),
    ];
    const before = await Promise.all(
      files.map((file) => fs.stat(path.join(root, file)).then((s) => s.mtimeMs)),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    await noosphere(root, home, 'activate', '--quiet');

    const after = await Promise.all(
      files.map((file) => fs.stat(path.join(root, file)).then((s) => s.mtimeMs)),
    );
    // activate runs from a shell prompt hook; a rewrite here would leave these
    // tracked files permanently dirty.
    assert.deepEqual(after, before);
  });

  it('still prunes when a selection is asserted explicitly', async () => {
    const { root, home } = await upgradedProject();
    await noosphere(root, home, 'activate', '--quiet');
    await noosphere(root, home, 'adapters', '--only', 'claude');

    assert.ok(await fs.readFile(path.join(root, 'CLAUDE.md'), 'utf8'));
    await assert.rejects(
      fs.readFile(path.join(root, 'GEMINI.md'), 'utf8'),
      (error) => error.code === 'ENOENT',
    );
  });
});
