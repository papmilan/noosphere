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
let matureProjectDir;
let lifecycleHome;
let storedActions;
let idempotencyKeys;

before(async () => {
  storedActions = [];
  idempotencyKeys = [];
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/v1/actions') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const action = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      storedActions.push(action);
      idempotencyKeys.push(req.headers['idempotency-key']);
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
  matureProjectDir = await mkdtemp(
    path.join(os.tmpdir(), 'noosphere-mature-project-'),
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
  await execFileAsync('git', ['init'], { cwd: matureProjectDir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: matureProjectDir,
  });
  await execFileAsync('git', ['config', 'user.name', 'Noosphere Test'], {
    cwd: matureProjectDir,
  });
  await writeFile(
    path.join(matureProjectDir, 'legacy.js'),
    'export const legacy = true;\n',
  );
  await execFileAsync('git', ['add', 'legacy.js'], {
    cwd: matureProjectDir,
  });
  await execFileAsync('git', ['commit', '-m', 'initial mature project'], {
    cwd: matureProjectDir,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2025-01-10T12:00:00Z',
      GIT_COMMITTER_DATE: '2025-01-10T12:00:00Z',
    },
  });
});

after(async () => {
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  server.close();
  await rm(projectDir, { recursive: true, force: true });
  await rm(secondProjectDir, { recursive: true, force: true });
  await rm(matureProjectDir, { recursive: true, force: true });
  await rm(lifecycleHome, { recursive: true, force: true });
});

describe('Noosphere continuity CLI', () => {
  it('initializes the universal protocol inside one .noosphere folder', async () => {
    await runCli(['init']);
    const configPath = path.join(
      projectDir,
      '.noosphere',
      'config.json',
    );
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.project_id = 'continuity-test';
    config.relayer_url = serverUrl;
    config.checkpoint_debounce_ms = 100;
    config.context_refresh_ms = 60_000;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const [protocol, protocolJson, journal, masterPrompt, followups] =
      await Promise.all([
      readFile(
        path.join(projectDir, '.noosphere', 'instructions.md'),
        'utf8',
      ),
      readFile(
        path.join(projectDir, '.noosphere', 'protocol.json'),
        'utf8',
      ),
      readFile(path.join(projectDir, '.noosphere', 'journal.md'), 'utf8'),
      readFile(
        path.join(projectDir, '.noosphere', 'master-prompt.md'),
        'utf8',
      ),
      readFile(
        path.join(projectDir, '.noosphere', 'followups.jsonl'),
        'utf8',
      ),
    ]);

    assert.deepEqual(config.adapters, []);
    assert.match(protocol, /universal agent protocol/i);
    assert.match(protocol, /Do not reveal or request hidden chain-of-thought/);
    assert.match(protocolJson, /"filesystem"/);
    assert.match(protocolJson, /"http"/);
    assert.match(protocolJson, /baseline\.md/);
    assert.match(protocolJson, /master-prompt\.md/);
    assert.match(protocolJson, /followups\.jsonl/);
    assert.match(journal, /public work journal/i);
    assert.equal(masterPrompt, '');
    assert.equal(followups, '');
    await assert.rejects(
      readFile(path.join(projectDir, '.noosphere', 'baseline.md'), 'utf8'),
    );
    for (const adapterPath of [
      '.mcp.json',
      '.noosphere.json',
      'AGENTS.md',
      'CLAUDE.md',
      'GEMINI.md',
      'NOOSPHERE.md',
      '.cursor',
    ]) {
      await assert.rejects(
        readFile(path.join(projectDir, adapterPath), 'utf8'),
      );
    }
  });

  it('keeps only the selected agent adapters', async () => {
    await runCli(['adapters', '--only', 'claude']);
    const config = JSON.parse(
      await readFile(
        path.join(projectDir, '.noosphere', 'config.json'),
        'utf8',
      ),
    );

    assert.deepEqual(config.adapters, ['claude']);
    assert.match(
      await readFile(path.join(projectDir, 'CLAUDE.md'), 'utf8'),
      /Noosphere continuity adapter/,
    );
    await assert.rejects(readFile(path.join(projectDir, 'AGENTS.md'), 'utf8'));
    await assert.rejects(readFile(path.join(projectDir, 'GEMINI.md'), 'utf8'));
    await assert.rejects(readFile(path.join(projectDir, '.mcp.json'), 'utf8'));
    await assert.rejects(
      readFile(path.join(projectDir, '.cursor', 'mcp.json'), 'utf8'),
    );
    await assert.rejects(readFile(path.join(projectDir, 'NOOSPHERE.md'), 'utf8'));
    assert.match(
      await readFile(
        path.join(projectDir, '.noosphere', 'instructions.md'),
        'utf8',
      ),
      /universal agent protocol/i,
    );
  });

  it('onboards an established repository with one bounded baseline', async () => {
    const before = storedActions.length;
    await runCli(['init'], matureProjectDir);
    const configPath = path.join(
      matureProjectDir,
      '.noosphere',
      'config.json',
    );
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.project_id = 'mature-project';
    config.relayer_url = serverUrl;
    config.onboarding.history_commits = 25;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const baseline = await readFile(
      path.join(matureProjectDir, '.noosphere', 'baseline.md'),
      'utf8',
    );
    const pendingState = JSON.parse(
      await readFile(
        path.join(matureProjectDir, '.noosphere', 'state.json'),
        'utf8',
      ),
    );
    assert.match(baseline, /machine-generated onboarding snapshot/i);
    assert.match(baseline, /initial mature project/);
    assert.match(baseline, /No source file contents or historical diffs/);
    assert.equal(pendingState.baseline.status, 'pending');
    assert.equal(storedActions.length, before);

    await runCli(['baseline'], matureProjectDir);
    assert.equal(storedActions.length, before + 1);
    assert.equal(storedActions.at(-1).action_type, 'project-baseline');
    assert.equal(storedActions.at(-1).project_id, 'mature-project');
    assert.equal(
      storedActions.at(-1).metadata.baseline.source_content_included,
      false,
    );

    await runCli(['baseline'], matureProjectDir);
    assert.equal(storedActions.length, before + 1);
    const storedState = JSON.parse(
      await readFile(
        path.join(matureProjectDir, '.noosphere', 'state.json'),
        'utf8',
      ),
    );
    assert.equal(storedState.baseline.status, 'stored');
    assert.equal(
      storedState.last_workspace_fingerprint,
      storedState.baseline.workspace_fingerprint,
    );
  });

  it('stores metadata-only checkpoints after workspace edits', async () => {
    await writeFile(path.join(projectDir, 'app.js'), 'export const value = 2;\n');
    await runCli(['checkpoint']);

    const checkpoints = storedActions.filter(
      (action) => action.action_type === 'checkpoint',
    );
    assert.equal(checkpoints.length, 1);
    const action = checkpoints[0];
    assert.equal(action.project_id, 'continuity-test');
    assert.equal(action.action_type, 'checkpoint');
    assert.match(action.content, /app\.js/);
    assert.match(action.content, /Raw source diff was not uploaded/);
    assert.ok(action.metadata.checkpoint.changed_files.includes('app.js'));
    assert.equal(action.metadata.privacy.include_diff, false);
    assert.equal('diff' in action.metadata.checkpoint, false);
  });

  it('uses a stable checkpoint identity when workspace content is unchanged', async () => {
    const startingCount = idempotencyKeys.length;
    await runCli(['checkpoint']);
    await runCli(['checkpoint']);

    const keys = idempotencyKeys.slice(startingCount);
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
  });

  it('keeps local-only journal edits out of automatic Walrus checkpoints', async () => {
    const child = spawn(process.execPath, [cli, 'watch'], {
      cwd: projectDir,
      env: {
        ...process.env,
        NOOSPHERE_HOME: lifecycleHome,
        NOOSPHERE_PROJECT_DIR: projectDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    const startingCount = storedActions.length;

    try {
      await waitFor(
        () => output.includes('Noosphere continuity watching continuity-test'),
        3_000,
      );
      await runCli([
        'journal',
        '--agent',
        'local-only',
        'This note must remain local.',
      ]);
      await delay(1_000);
      assert.equal(storedActions.length, startingCount);
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('close', resolve));
    }
  });

  it('auto-initializes and registers separate Git projects', async () => {
    const nested = path.join(secondProjectDir, 'src', 'nested');
    await mkdir(nested, { recursive: true });
    await runCli(['activate', '--quiet'], secondProjectDir);
    const secondConfigPath = path.join(
      secondProjectDir,
      '.noosphere',
      'config.json',
    );
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
    let managerOutput = '';
    child.stdout.on('data', (chunk) => {
      managerOutput += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      managerOutput += chunk.toString();
    });
    const startingCount = storedActions.length;
    try {
      await waitFor(
        () =>
          managerOutput.includes(`Watching continuity-test`) &&
          managerOutput.includes(`Watching second-project`) &&
          managerOutput.includes(
            'Noosphere continuity watching continuity-test',
          ) &&
          managerOutput.includes(
            'Noosphere continuity watching second-project',
          ),
        5_000,
      );
      await writeFile(
        path.join(projectDir, 'app.js'),
        'export const value = 4;\n',
      );
      await writeFile(
        path.join(secondProjectDir, 'second.js'),
        'export const second = 2;\n',
      );
      try {
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
      } catch (error) {
        const firstState = await readFile(
          path.join(projectDir, '.noosphere', 'state.json'),
          'utf8',
        ).catch(() => 'missing');
        const firstDiff = await execFileAsync(
          'git',
          ['diff', '--', 'app.js'],
          { cwd: projectDir },
        ).then(({ stdout }) => stdout).catch(() => 'git diff failed');
        const recentProjects = storedActions
          .slice(startingCount)
          .map((action) => action.project_id);
        throw new Error(
          `${error.message}\nManager output:\n${managerOutput}` +
          `\nRecent projects: ${JSON.stringify(recentProjects)}` +
          `\nFirst state: ${firstState}\nFirst diff:\n${firstDiff}`,
        );
      }
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
    const configPath = path.join(
      projectDir,
      '.noosphere',
      'config.json',
    );
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
        NOOSPHERE_CHECKPOINT_RETRY_BASE_MS: '200',
        NOOSPHERE_CHECKPOINT_RETRY_MAX_MS: '1_000',
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

  it('pins the master prompt and appends later prompts as ordered intent', async () => {
    const masterPrompt = [
      '# Build the outreach engine',
      '',
      'Phase 1: Create the contact importer.',
      'Phase 2: Add campaign scheduling and retries.',
      'Phase 3: Add reporting and export.',
      '',
      'Only implement Phase 1 in this session.',
      'Keep the remaining phases unchanged so another agent can continue later.',
    ].join('\n');
    const replacement = [
      '# Different plan',
      '',
      'Phase 1: Replace the importer.',
      'Phase 2: Remove campaign scheduling.',
      'Phase 3: Replace reporting with a dashboard.',
      '',
      'This is deliberately long enough to qualify as a second structured plan,',
      'but automatic capture must not replace the already pinned project intent.',
    ].join('\n');
    const before = storedActions.length;

    const captureOutput = await runCli([
      'capture-prompt',
      '--local-only',
      '--content',
      masterPrompt,
    ]);
    assert.match(captureOutput, /saved locally/i);
    assert.equal(
      await readFile(
        path.join(projectDir, '.noosphere', 'master-prompt.md'),
        'utf8',
      ),
      masterPrompt,
    );
    assert.equal(storedActions.length, before);

    await runCli(['share-master-prompt', '--agent', 'claude-code']);
    assert.equal(storedActions.length, before + 1);
    assert.equal(storedActions.at(-1).action_type, 'master-prompt');
    assert.equal(storedActions.at(-1).content, masterPrompt);

    const followupOutput = await runCli([
      'capture-prompt',
      '--content',
      replacement,
    ]);
    assert.match(followupOutput, /Follow-up prompt captured exactly/i);
    assert.equal(
      await readFile(
        path.join(projectDir, '.noosphere', 'master-prompt.md'),
        'utf8',
      ),
      masterPrompt,
    );
    assert.equal(storedActions.length, before + 2);
    assert.equal(storedActions.at(-1).action_type, 'user-followup');
    assert.equal(storedActions.at(-1).content, replacement);

    const shortFollowup = 'Continue with phase 2, but use a 30 second timeout.';
    await runCli([
      'capture-prompt',
      '--content',
      shortFollowup,
    ]);
    const followups = (
      await readFile(
        path.join(projectDir, '.noosphere', 'followups.jsonl'),
        'utf8',
      )
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      followups.map((entry) => entry.content),
      [replacement, shortFollowup],
    );
    assert.equal(storedActions.at(-1).action_type, 'user-followup');
    assert.equal(storedActions.at(-1).content, shortFollowup);

    await runCli(['refresh']);
    const context = await readFile(
      path.join(projectDir, '.noosphere', 'context.md'),
      'utf8',
    );
    assert.match(context, /## Pinned master prompt/);
    assert.match(context, /Phase 2: Add campaign scheduling and retries/);
    assert.match(context, /## Follow-up user instructions/);
    assert.match(context, /Continue with phase 2, but use a 30 second timeout/);
    assert.match(context, /## Completion evidence/);
    assert.ok(
      context.indexOf('## Pinned master prompt') <
        context.indexOf('## Follow-up user instructions'),
    );
    assert.ok(
      context.indexOf('## Follow-up user instructions') <
        context.indexOf('## Completion evidence'),
    );

    const explicitReplacement = 'Use the revised project plan in plan-v2.md.';
    await runCli([
      'master-prompt',
      '--replace',
      '--content',
      explicitReplacement,
    ]);
    assert.equal(
      await readFile(
        path.join(projectDir, '.noosphere', 'master-prompt.md'),
        'utf8',
      ),
      explicitReplacement,
    );
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
