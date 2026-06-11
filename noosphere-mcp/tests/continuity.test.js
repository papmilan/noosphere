import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  realpath,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const cli = path.join(packageRoot, 'continuity', 'index.js');

let server;
let serverUrl;
let projectDir;
let secondProjectDir;
let lifecycleHome;
let storedActions;

before(async () => {
  storedActions = [];
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/v1/actions') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const action = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      storedActions.push(action);
      respondJson(res, 201, {
        success: true,
        blob_id: `blob-${storedActions.length}`,
      });
      return;
    }
    if (
      req.method === 'GET' &&
      url.pathname === '/v1/projects/continuity-test/context'
    ) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(
        '--- NOOSPHERE CONTEXT: continuity-test ---\nShared checkpoint.\n--- END NOOSPHERE CONTEXT ---',
      );
      return;
    }
    respondJson(res, 404, { error: 'not found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  serverUrl = `http://127.0.0.1:${server.address().port}`;

  projectDir = await mkdtemp(path.join(os.tmpdir(), 'noosphere-continuity-'));
  secondProjectDir = await mkdtemp(
    path.join(os.tmpdir(), 'noosphere-second-project-'),
  );
  lifecycleHome = await mkdtemp(
    path.join(os.tmpdir(), 'noosphere-user-home-'),
  );
  await execFileAsync('git', ['init'], { cwd: projectDir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: projectDir,
  });
  await execFileAsync('git', ['config', 'user.name', 'Noosphere Test'], {
    cwd: projectDir,
  });
  await writeFile(path.join(projectDir, 'app.js'), 'export const value = 1;\n');
  await execFileAsync('git', ['add', 'app.js'], { cwd: projectDir });
  await execFileAsync('git', ['commit', '-m', 'initial'], {
    cwd: projectDir,
  });
  await execFileAsync('git', ['init'], { cwd: secondProjectDir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: secondProjectDir,
  });
  await execFileAsync('git', ['config', 'user.name', 'Noosphere Test'], {
    cwd: secondProjectDir,
  });
  await writeFile(
    path.join(secondProjectDir, 'second.js'),
    'export const second = 1;\n',
  );
  await execFileAsync('git', ['add', 'second.js'], {
    cwd: secondProjectDir,
  });
  await execFileAsync('git', ['commit', '-m', 'initial'], {
    cwd: secondProjectDir,
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(projectDir, { recursive: true, force: true });
  await rm(secondProjectDir, { recursive: true, force: true });
  await rm(lifecycleHome, { recursive: true, force: true });
});

describe('Noosphere continuity CLI', () => {
  it('initializes cross-agent instructions and project-specific MCP configs', async () => {
    await runCli(['init']);
    const configPath = path.join(projectDir, '.noosphere.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.project_id = 'continuity-test';
    config.relayer_url = serverUrl;
    config.checkpoint_debounce_ms = 100;
    config.context_refresh_ms = 60_000;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const [
      mcpConfig,
      cursorMcp,
      cursorRule,
      agents,
      claude,
      gemini,
      protocol,
      protocolJson,
      journal,
    ] =
      await Promise.all([
        readFile(path.join(projectDir, '.mcp.json'), 'utf8'),
        readFile(path.join(projectDir, '.cursor', 'mcp.json'), 'utf8'),
        readFile(
          path.join(projectDir, '.cursor', 'rules', 'noosphere.mdc'),
          'utf8',
        ),
        readFile(path.join(projectDir, 'AGENTS.md'), 'utf8'),
        readFile(path.join(projectDir, 'CLAUDE.md'), 'utf8'),
        readFile(path.join(projectDir, 'GEMINI.md'), 'utf8'),
        readFile(path.join(projectDir, 'NOOSPHERE.md'), 'utf8'),
        readFile(
          path.join(projectDir, '.noosphere', 'protocol.json'),
          'utf8',
        ),
        readFile(path.join(projectDir, '.noosphere', 'journal.md'), 'utf8'),
      ]);

    assert.match(mcpConfig, /memwal-mcp@0\.0\.4/);
    assert.match(cursorMcp, /memwal-mcp@0\.0\.4/);
    assert.match(cursorRule, /universal Noosphere continuity protocol/);
    assert.match(agents, /vendor-neutral/);
    assert.match(claude, /vendor-neutral/);
    assert.match(gemini, /vendor-neutral/);
    assert.match(protocol, /universal agent protocol/i);
    assert.match(protocol, /Do not reveal or request hidden chain-of-thought/);
    assert.match(protocolJson, /"filesystem"/);
    assert.match(protocolJson, /"http"/);
    assert.match(journal, /public work journal/i);
  });

  it('stores metadata-only checkpoints after workspace edits', async () => {
    await writeFile(path.join(projectDir, 'app.js'), 'export const value = 2;\n');
    await runCli(['checkpoint']);

    assert.equal(storedActions.length, 1);
    const action = storedActions[0];
    assert.equal(action.project_id, 'continuity-test');
    assert.equal(action.action_type, 'checkpoint');
    assert.match(action.content, /app\.js/);
    assert.match(action.content, /Raw source diff was not uploaded/);
    assert.ok(action.metadata.checkpoint.changed_files.includes('app.js'));
    assert.equal(action.metadata.privacy.include_diff, false);
    assert.equal('diff' in action.metadata.checkpoint, false);
  });

  it('auto-initializes and registers separate Git projects', async () => {
    const nested = path.join(secondProjectDir, 'src', 'nested');
    await mkdir(nested, { recursive: true });
    await runCli(['activate', '--quiet'], secondProjectDir);
    const secondConfigPath = path.join(secondProjectDir, '.noosphere.json');
    const secondConfig = JSON.parse(
      await readFile(secondConfigPath, 'utf8'),
    );
    secondConfig.project_id = 'second-project';
    secondConfig.relayer_url = serverUrl;
    secondConfig.checkpoint_debounce_ms = 100;
    secondConfig.context_refresh_ms = 60_000;
    await writeFile(
      secondConfigPath,
      `${JSON.stringify(secondConfig, null, 2)}\n`,
    );
    await runCli(['activate', '--quiet'], nested);
    await runCli(['activate', '--quiet'], projectDir);

    const registry = JSON.parse(
      await readFile(path.join(lifecycleHome, 'projects.json'), 'utf8'),
    );
    const canonicalFirst = await realpath(projectDir);
    const canonicalSecond = await realpath(secondProjectDir);
    assert.equal(registry.projects.length, 2);
    assert.ok(
      registry.projects.some((project) => project.path === canonicalFirst),
    );
    assert.ok(
      registry.projects.some(
        (project) => project.path === canonicalSecond,
      ),
    );
  });

  it('one manager automatically watches every registered project', async () => {
    const manager = path.join(packageRoot, 'lifecycle', 'manager.js');
    const child = spawn(process.execPath, [manager], {
      env: {
        ...process.env,
        NOOSPHERE_HOME: lifecycleHome,
        NOOSPHERE_MANAGER_POLL_MS: '100',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const startingCount = storedActions.length;
    try {
      await delay(250);
      await writeFile(
        path.join(projectDir, 'app.js'),
        'export const value = 4;\n',
      );
      await writeFile(
        path.join(secondProjectDir, 'second.js'),
        'export const second = 2;\n',
      );
      await waitFor(
        () => {
          const recent = storedActions.slice(startingCount);
          return (
            recent.some(
              (action) => action.project_id === 'continuity-test',
            ) &&
            recent.some(
              (action) => action.project_id === 'second-project',
            )
          );
        },
        10_000,
      );
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('close', resolve));
    }
  });

  it('refreshes the shared context file for every agent', async () => {
    await mkdir(path.join(projectDir, '.noosphere'), { recursive: true });
    await runCli(['refresh']);
    const context = await readFile(
      path.join(projectDir, '.noosphere', 'context.md'),
      'utf8',
    );

    assert.match(context, /Shared checkpoint/);
    assert.match(context, /Read this before changing the project/);
  });

  it('supports generic CLI journaling, remembering, and context output', async () => {
    await runCli([
      'journal',
      '--agent',
      'unknown-cli',
      'Found a reproducible cache invalidation failure.',
    ]);
    const journal = await readFile(
      path.join(projectDir, '.noosphere', 'journal.md'),
      'utf8',
    );
    assert.match(journal, /unknown-cli/);
    assert.match(journal, /cache invalidation failure/);

    await runCli([
      'remember',
      '--agent',
      'unknown-cli',
      '--type',
      'finding',
      'The failure occurs after a stale cache read.',
    ]);
    assert.equal(storedActions.at(-1).agent_id, 'unknown-cli');
    assert.equal(storedActions.at(-1).action_type, 'finding');

    const output = await runCli(['context']);
    assert.match(output, /Noosphere shared context/);
  });

  it('watch mode retries a checkpoint after a temporary relayer failure', async () => {
    const actionCountBeforeWatch = storedActions.length;
    const originalUrl = serverUrl;
    const configPath = path.join(projectDir, '.noosphere.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.relayer_url = 'http://127.0.0.1:1';
    config.checkpoint_debounce_ms = 100;
    config.context_refresh_ms = 60_000;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const child = spawn(process.execPath, [cli, 'watch'], {
      cwd: projectDir,
      env: {
        ...process.env,
        NOOSPHERE_PROJECT_DIR: projectDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      await writeFile(
        path.join(projectDir, 'app.js'),
        'export const value = 3;\n',
      );
      await delay(500);
      config.relayer_url = originalUrl;
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
      await waitFor(
        () => storedActions.length > actionCountBeforeWatch,
        4_000,
      );
      assert.match(storedActions.at(-1).content, /app\.js/);
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('close', resolve));
    }
  });
});

async function runCli(args, cwd = projectDir) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd,
    env: {
      ...process.env,
      NOOSPHERE_HOME: lifecycleHome,
      NOOSPHERE_PROJECT_DIR: cwd,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const code = await new Promise((resolve) => child.once('close', resolve));
  assert.equal(
    code,
    0,
    `${Buffer.concat(stderr).toString()}\n${Buffer.concat(stdout).toString()}`,
  );
  return Buffer.concat(stdout).toString();
}

function respondJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate, timeoutMs) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('Timed out waiting for watcher checkpoint');
    }
    await delay(50);
  }
}
