/**
 * ide-bridge.test.js — tests for the IDE bridge daemon and the `register` CLI command.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const ideBridgeModule = path.join(packageRoot, 'lifecycle', 'ide-bridge.js');
const cli = path.join(packageRoot, 'continuity', 'index.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, intervalMs = 50) {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs} ms`);
    }
    await delay(intervalMs);
  }
}

/**
 * Write a `.noosphere/ide-hint.json` into the given directory.
 */
async function writeHintFile(dir, projectId) {
  await mkdir(path.join(dir, '.noosphere'), { recursive: true });
  const hint = {
    project_id: projectId,
    registered_at: new Date().toISOString(),
  };
  await writeFile(
    path.join(dir, '.noosphere', 'ide-hint.json'),
    `${JSON.stringify(hint, null, 2)}\n`,
    'utf8',
  );
}

/**
 * Read the registry JSON from a fake NOOSPHERE_HOME.
 * Returns { version, projects } or null if missing.
 */
async function readRegistry(noosphereHome) {
  try {
    return JSON.parse(
      await readFile(path.join(noosphereHome, 'projects.json'), 'utf8'),
    );
  } catch {
    return null;
  }
}

/**
 * Import the ide-bridge module so we can call its exported functions directly.
 * We use a dynamic import so the module-level daemon code does NOT run
 * (process.argv[1] will be the test runner, not ide-bridge.js).
 */
async function importBridge() {
  return import(pathToFileURL(ideBridgeModule).href);
}

// ---------------------------------------------------------------------------
// Fixture setup / teardown
// ---------------------------------------------------------------------------

let tmpRoot;

before(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'noosphere-ide-bridge-'));
});

after(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Unit tests for scanForHints and scanAndRegister
// ---------------------------------------------------------------------------

describe('ide-bridge: scanForHints', () => {
  it('finds hint files in a nested project tree', async () => {
    const { scanForHints } = await importBridge();

    const root = await mkdtemp(path.join(tmpRoot, 'scan-basic-'));
    // Project at depth 1
    const proj1 = path.join(root, 'workspace', 'proj1');
    await writeHintFile(proj1, 'proj-one');
    // Project at depth 2
    const proj2 = path.join(root, 'workspace', 'sub', 'proj2');
    await writeHintFile(proj2, 'proj-two');

    const found = [];
    for await (const dir of scanForHints(root)) {
      found.push(dir);
    }

    assert.ok(
      found.some((d) => d === proj1 || d.endsWith('proj1')),
      'should find proj1',
    );
    assert.ok(
      found.some((d) => d === proj2 || d.endsWith('proj2')),
      'should find proj2',
    );
  });

  it('skips directories containing .noosphere-ignore', async () => {
    const { scanForHints } = await importBridge();

    const root = await mkdtemp(path.join(tmpRoot, 'scan-ignore-'));
    const ignoredDir = path.join(root, 'ignored-project');
    await writeHintFile(ignoredDir, 'ignored');
    // Place the ignore marker inside the ignored directory
    await writeFile(path.join(ignoredDir, '.noosphere-ignore'), '', 'utf8');

    const visibleDir = path.join(root, 'visible-project');
    await writeHintFile(visibleDir, 'visible');

    const found = [];
    for await (const dir of scanForHints(root)) {
      found.push(dir);
    }

    assert.ok(
      !found.some((d) => d === ignoredDir || d.includes('ignored-project')),
      'ignored directory must not appear',
    );
    assert.ok(
      found.some((d) => d === visibleDir || d.includes('visible-project')),
      'visible directory must appear',
    );
  });

  it('skips the entire subtree when .noosphere-ignore is at the workspace root', async () => {
    const { scanForHints } = await importBridge();

    const root = await mkdtemp(path.join(tmpRoot, 'scan-root-ignore-'));
    // Place ignore at root
    await writeFile(path.join(root, '.noosphere-ignore'), '', 'utf8');
    // A hint inside should not be found
    const inner = path.join(root, 'proj');
    await writeHintFile(inner, 'inner-proj');

    const found = [];
    for await (const dir of scanForHints(root)) {
      found.push(dir);
    }

    assert.equal(found.length, 0, 'nothing should be found under an ignored root');
  });

  it('does not return hint files deeper than MAX_DEPTH (3) levels', async () => {
    const { scanForHints } = await importBridge();

    const root = await mkdtemp(path.join(tmpRoot, 'scan-depth-'));

    // depth 3: root/a/b/c — should be found (MAX_DEPTH = 3, depth starts at 0)
    const depth3 = path.join(root, 'a', 'b', 'c');
    await writeHintFile(depth3, 'depth-three');

    // depth 4: root/a/b/c/d — must NOT be found
    const depth4 = path.join(root, 'a', 'b', 'c', 'd');
    await writeHintFile(depth4, 'depth-four');

    const found = [];
    for await (const dir of scanForHints(root)) {
      found.push(dir);
    }

    assert.ok(
      found.some((d) => d === depth3 || d.endsWith(path.join('a', 'b', 'c'))),
      'depth-3 project should be found',
    );
    assert.ok(
      !found.some((d) => d === depth4 || d.endsWith(path.join('a', 'b', 'c', 'd'))),
      'depth-4 project must not be found',
    );
  });

  it('skips node_modules, .git, dist, build, .cache, and vendor directories', async () => {
    const { scanForHints } = await importBridge();

    const root = await mkdtemp(path.join(tmpRoot, 'scan-skip-'));
    const skipNames = ['node_modules', '.git', 'dist', 'build', '.cache', 'vendor'];

    for (const name of skipNames) {
      const dir = path.join(root, name, 'sneaky');
      await writeHintFile(dir, `sneaky-${name}`);
    }
    // A legitimate project
    const legitDir = path.join(root, 'legit-project');
    await writeHintFile(legitDir, 'legit');

    const found = [];
    for await (const dir of scanForHints(root)) {
      found.push(dir);
    }

    for (const name of skipNames) {
      assert.ok(
        !found.some((d) => d.includes(name)),
        `must skip ${name}`,
      );
    }
    assert.ok(
      found.some((d) => d === legitDir || d.includes('legit-project')),
      'legit project must be found',
    );
  });
});

// ---------------------------------------------------------------------------

describe('ide-bridge: scanAndRegister', () => {
  it('registers a project found in a workspace root', async () => {
    const { scanAndRegister } = await importBridge();

    const workspaceRoot = await mkdtemp(path.join(tmpRoot, 'reg-basic-'));
    const noosphereHome = await mkdtemp(path.join(tmpRoot, 'reg-basic-home-'));

    const proj = path.join(workspaceRoot, 'my-project');
    await writeHintFile(proj, 'my-project');

    // Write ide-workspaces.json
    await writeFile(
      path.join(noosphereHome, 'ide-workspaces.json'),
      JSON.stringify({ roots: [workspaceRoot] }),
      'utf8',
    );

    const env = { NOOSPHERE_HOME: noosphereHome };
    await scanAndRegister(env);

    const registry = await readRegistry(noosphereHome);
    assert.ok(registry !== null, 'registry should exist');
    assert.ok(
      registry.projects.some((p) => p.project_id === 'my-project'),
      'project must be in registry',
    );
  });

  it('is idempotent — does not duplicate entries', async () => {
    const { scanAndRegister } = await importBridge();

    const workspaceRoot = await mkdtemp(path.join(tmpRoot, 'reg-idem-'));
    const noosphereHome = await mkdtemp(path.join(tmpRoot, 'reg-idem-home-'));

    const proj = path.join(workspaceRoot, 'idem-project');
    await writeHintFile(proj, 'idem-project');

    await writeFile(
      path.join(noosphereHome, 'ide-workspaces.json'),
      JSON.stringify({ roots: [workspaceRoot] }),
      'utf8',
    );

    const env = { NOOSPHERE_HOME: noosphereHome };
    await scanAndRegister(env);
    await scanAndRegister(env);
    await scanAndRegister(env);

    const registry = await readRegistry(noosphereHome);
    const matches = registry.projects.filter((p) => p.project_id === 'idem-project');
    assert.equal(matches.length, 1, 'should register exactly once');
  });

  it('deduplicates a symlink pointing to the same physical directory', async () => {
    const { scanAndRegister } = await importBridge();

    // Skip on platforms where symlink creation requires elevated privileges
    const workspaceRoot = await mkdtemp(path.join(tmpRoot, 'reg-sym-'));
    const noosphereHome = await mkdtemp(path.join(tmpRoot, 'reg-sym-home-'));

    const realProj = path.join(workspaceRoot, 'real-project');
    await writeHintFile(realProj, 'sym-project');

    const linkProj = path.join(workspaceRoot, 'link-project');
    try {
      await symlink(realProj, linkProj);
    } catch {
      // Symlinks not supported in this environment — skip the rest
      return;
    }

    // Both real-project and link-project should be discovered by the scan,
    // but after canonicalisation only one entry should appear in the registry.
    await writeFile(
      path.join(noosphereHome, 'ide-workspaces.json'),
      JSON.stringify({ roots: [workspaceRoot] }),
      'utf8',
    );

    const env = { NOOSPHERE_HOME: noosphereHome };
    await scanAndRegister(env);

    const registry = await readRegistry(noosphereHome);
    const matches = registry.projects.filter((p) => p.project_id === 'sym-project');
    assert.equal(
      matches.length,
      1,
      'symlink and real dir must deduplicate to a single registry entry',
    );
  });

  it('skips .noosphere-ignore directories', async () => {
    const { scanAndRegister } = await importBridge();

    const workspaceRoot = await mkdtemp(path.join(tmpRoot, 'reg-ignore-'));
    const noosphereHome = await mkdtemp(path.join(tmpRoot, 'reg-ignore-home-'));

    const ignoredProj = path.join(workspaceRoot, 'ignored');
    await writeHintFile(ignoredProj, 'ignored-proj');
    await writeFile(path.join(ignoredProj, '.noosphere-ignore'), '', 'utf8');

    const visibleProj = path.join(workspaceRoot, 'visible');
    await writeHintFile(visibleProj, 'visible-proj');

    await writeFile(
      path.join(noosphereHome, 'ide-workspaces.json'),
      JSON.stringify({ roots: [workspaceRoot] }),
      'utf8',
    );

    const env = { NOOSPHERE_HOME: noosphereHome };
    await scanAndRegister(env);

    const registry = await readRegistry(noosphereHome);
    assert.ok(
      !registry.projects.some((p) => p.project_id === 'ignored-proj'),
      'ignored project must not be registered',
    );
    assert.ok(
      registry.projects.some((p) => p.project_id === 'visible-proj'),
      'visible project must be registered',
    );
  });

  it('does not scan any directory when ide-workspaces.json is absent', async () => {
    const { readWorkspaceRoots } = await importBridge();
    const noosphereHome = await mkdtemp(path.join(tmpRoot, 'reg-defaults-home-'));
    // No ide-workspaces.json written
    const roots = await readWorkspaceRoots({ NOOSPHERE_HOME: noosphereHome });
    assert.deepEqual(roots, []);
  });
});

// ---------------------------------------------------------------------------
// Daemon process tests
// ---------------------------------------------------------------------------

describe('ide-bridge: daemon process', () => {
  it('exits cleanly on SIGTERM', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpRoot, 'daemon-sigterm-'));
    const noosphereHome = await mkdtemp(path.join(tmpRoot, 'daemon-sigterm-home-'));

    await writeFile(
      path.join(noosphereHome, 'ide-workspaces.json'),
      JSON.stringify({ roots: [workspaceRoot] }),
      'utf8',
    );

    const child = spawn(process.execPath, [ideBridgeModule], {
      env: {
        ...process.env,
        NOOSPHERE_HOME: noosphereHome,
        NOOSPHERE_IDE_POLL_MS: '60000', // long interval — we don't need it to scan again
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Give the process a moment to start and finish its first scan
    await delay(300);

    const result = await new Promise((resolve) => {
      child.once('close', (code, signal) => resolve({ code, signal }));
      child.kill('SIGTERM');
    });

    if (result.code === null && process.platform === 'win32') {
      assert.equal(result.signal, 'SIGTERM');
    } else {
      assert.deepEqual(result, { code: 0, signal: null });
    }
  });

  it('registers projects after a scan cycle', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpRoot, 'daemon-scan-'));
    const noosphereHome = await mkdtemp(path.join(tmpRoot, 'daemon-scan-home-'));

    // Write ide-workspaces.json before starting the daemon
    await writeFile(
      path.join(noosphereHome, 'ide-workspaces.json'),
      JSON.stringify({ roots: [workspaceRoot] }),
      'utf8',
    );

    // Create a project hint BEFORE the daemon starts so the first scan picks it up
    const proj = path.join(workspaceRoot, 'daemon-project');
    await writeHintFile(proj, 'daemon-project');

    const child = spawn(process.execPath, [ideBridgeModule], {
      env: {
        ...process.env,
        NOOSPHERE_HOME: noosphereHome,
        NOOSPHERE_IDE_POLL_MS: '500',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      await waitFor(async () => {
        const registry = await readRegistry(noosphereHome);
        return (
          registry !== null &&
          registry.projects.some((p) => p.project_id === 'daemon-project')
        );
      }, 4_000);

      const registry = await readRegistry(noosphereHome);
      assert.ok(
        registry.projects.some((p) => p.project_id === 'daemon-project'),
        'daemon must register the project',
      );
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('close', resolve));
    }
  });
});

// ---------------------------------------------------------------------------
// CLI `register` command tests
// ---------------------------------------------------------------------------

describe('continuity CLI: register command', () => {
  it('writes ide-hint.json and registers the current Git project', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    const projectDir = await mkdtemp(path.join(tmpRoot, 'cli-register-'));
    const noosphereHome = await mkdtemp(path.join(tmpRoot, 'cli-register-home-'));

    // Initialise a Git repository
    await execFileAsync('git', ['init'], { cwd: projectDir });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: projectDir,
    });
    await execFileAsync('git', ['config', 'user.name', 'Test'], {
      cwd: projectDir,
    });
    await writeFile(path.join(projectDir, 'README.md'), '# test\n', 'utf8');
    await execFileAsync('git', ['add', 'README.md'], { cwd: projectDir });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: projectDir });

    const child = spawn(process.execPath, [cli, 'register'], {
      cwd: projectDir,
      env: {
        ...process.env,
        NOOSPHERE_HOME: noosphereHome,
        NOOSPHERE_PROJECT_DIR: projectDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));

    const code = await new Promise((resolve) => child.once('close', resolve));
    const stdoutText = Buffer.concat(stdout).toString();
    const stderrText = Buffer.concat(stderr).toString();

    assert.equal(
      code,
      0,
      `register exited ${code}\nSTDERR: ${stderrText}\nSTDOUT: ${stdoutText}`,
    );
    assert.match(stdoutText, /Project registered:/);

    // ide-hint.json must be written
    const hintPath = path.join(projectDir, '.noosphere', 'ide-hint.json');
    assert.ok(await exists(hintPath), 'ide-hint.json must be written');
    const hint = JSON.parse(await readFile(hintPath, 'utf8'));
    assert.ok(typeof hint.project_id === 'string' && hint.project_id.length > 0);

    // Project must appear in the registry
    const registry = await readRegistry(noosphereHome);
    assert.ok(
      registry !== null && registry.projects.some(
        (p) => p.project_id === hint.project_id,
      ),
      'project must be in the registry',
    );
  });

  it('fails gracefully when called outside a Git repository', async () => {
    const notGitDir = await mkdtemp(path.join(tmpRoot, 'cli-no-git-'));
    const noosphereHome = await mkdtemp(path.join(tmpRoot, 'cli-no-git-home-'));

    const child = spawn(process.execPath, [cli, 'register'], {
      cwd: notGitDir,
      env: {
        ...process.env,
        NOOSPHERE_HOME: noosphereHome,
        NOOSPHERE_PROJECT_DIR: notGitDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stderr = [];
    child.stderr.on('data', (chunk) => stderr.push(chunk));

    const code = await new Promise((resolve) => child.once('close', resolve));
    assert.notEqual(code, 0, 'should exit non-zero outside a Git repo');
    assert.match(
      Buffer.concat(stderr).toString(),
      /Git repository|git/i,
    );
  });

  it('registers an explicit repository path from outside the project', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    const projectDir = await mkdtemp(path.join(tmpRoot, 'cli-explicit-'));
    const launchDir = await mkdtemp(path.join(tmpRoot, 'cli-launch-'));
    const noosphereHome = await mkdtemp(path.join(tmpRoot, 'cli-explicit-home-'));

    await execFileAsync('git', ['init'], { cwd: projectDir });

    const child = spawn(
      process.execPath,
      [cli, 'register', '--path', projectDir],
      {
        cwd: launchDir,
        env: {
          ...process.env,
          NOOSPHERE_HOME: noosphereHome,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));

    const code = await new Promise((resolve) => child.once('close', resolve));
    assert.equal(
      code,
      0,
      Buffer.concat(stderr).toString() || Buffer.concat(stdout).toString(),
    );

    const registry = await readRegistry(noosphereHome);
    assert.equal(registry.projects.length, 1);
    assert.equal(
      await realpath(registry.projects[0].path),
      await realpath(projectDir),
    );
  });
});
