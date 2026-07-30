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

function normalizeSeparators(value) {
  return value.replaceAll('\\', '/');
}

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

// The CLI locates a project with `git rev-parse --show-toplevel` and treats any
// git failure as "not a git project", which it then skips quietly with status 0.
// Inherited GIT_* variables therefore turn a broken fixture into a silent no-op,
// so drop them and give the child a git environment that depends on nothing
// outside the temp project.
// The CLI resolves its project from --path, then NOOSPHERE_PROJECT_DIR, then
// INIT_CWD, and only then the working directory. npm sets INIT_CWD to wherever
// `npm run` was invoked, so under `npm run check` — which is how CI runs the
// suite — the CLI targeted the repository checkout and ignored the child's cwd
// entirely, leaving the temp project untouched and exiting 0.
function childEnv(home) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith('GIT_') &&
        key !== 'INIT_CWD' &&
        key !== 'NOOSPHERE_PROJECT_DIR',
    ),
  );
  return {
    ...env,
    NOOSPHERE_HOME: home,
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'),
    GIT_CONFIG_SYSTEM: path.join(home, 'gitconfig'),
  };
}

async function noosphere(root, home, ...args) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: root,
    env: childEnv(home),
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
  // Build the repository with the same environment the CLI will use, so the
  // fixture cannot succeed under an environment the CLI never sees.
  await fs.writeFile(path.join(home, 'gitconfig'), '');
  const git = (...args) => execFileAsync('git', args, { cwd: root, env: childEnv(home) });
  await git('init', '-q', '.');
  await git('config', 'user.email', 't@t');
  await git('config', 'user.name', 't');
  await git('commit', '-q', '--allow-empty', '-m', 'init');

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

  // Assert the fixture is what the CLI will see, through the CLI's own
  // environment. Checking git from the test process instead hid the first
  // failure of this suite: activate could not find the project, skipped it, and
  // exited 0, so every assertion below failed while describing file contents.
  // git reports the toplevel with forward slashes on Windows while mkdtemp and
  // path.join produce backslashes, so compare the paths, not the separators.
  const toplevel = (await git('rev-parse', '--show-toplevel')).stdout.trim();
  assert.equal(
    normalizeSeparators(toplevel),
    normalizeSeparators(root),
    'git and the CLI must agree on the project root',
  );
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
