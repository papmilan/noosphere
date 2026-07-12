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
const CLI_TIMEOUT_MS = 8_000;

let server;
let serverUrl;
let projectDir;
let secondProjectDir;
let recentProjectDir;
let emptyProjectDir;
let lifecycleHome;
let storedActions;
let idempotencyKeys;
let typedRecallMemories;

before(async () => {
  storedActions = [];
  idempotencyKeys = [];
  typedRecallMemories = [];
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') {
      respondJson(res, 200, { status: 'ok' });
      return;
    }
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
      req.method === 'POST' &&
      url.pathname === '/v1/projects/continuity-test/recall'
    ) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const memories = typedRecallMemories
        .filter((memory) => memory.action_type === request.action_type)
        .slice(0, request.limit || 10);
      respondJson(res, 200, {
        success: true,
        project_id: 'continuity-test',
        query: request.query,
        retrieval: 'semantic',
        total: memories.length,
        memories,
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
  recentProjectDir = await mkdtemp(
    path.join(os.tmpdir(), 'noosphere-recent-project-'),
  );
  emptyProjectDir = await mkdtemp(
    path.join(os.tmpdir(), 'noosphere-empty-project-'),
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
  await execFileAsync('git', ['init'], { cwd: recentProjectDir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: recentProjectDir,
  });
  await execFileAsync('git', ['config', 'user.name', 'Noosphere Test'], {
    cwd: recentProjectDir,
  });
  await writeFile(
    path.join(recentProjectDir, 'recent.js'),
    'export const recent = true;\n',
  );
  await execFileAsync('git', ['add', 'recent.js'], {
    cwd: recentProjectDir,
  });
  await execFileAsync('git', ['commit', '-m', 'initial recent project'], {
    cwd: recentProjectDir,
  });
  await execFileAsync('git', ['init'], { cwd: emptyProjectDir });
});

after(async () => {
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  server.close();
  await rm(projectDir, { recursive: true, force: true });
  await rm(secondProjectDir, { recursive: true, force: true });
  await rm(recentProjectDir, { recursive: true, force: true });
  await rm(emptyProjectDir, { recursive: true, force: true });
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
    assert.match(
      await readFile(
        path.join(projectDir, '.noosphere', 'baseline.md'),
        'utf8',
      ),
      /moment Noosphere was first activated/,
    );
    await runCli(['baseline']);
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

  it('onboards a repository with one recent commit and no age threshold', async () => {
    const before = storedActions.length;
    await runCli(['init'], recentProjectDir);
    const configPath = path.join(
      recentProjectDir,
      '.noosphere',
      'config.json',
    );
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.project_id = 'recent-project';
    config.relayer_url = serverUrl;
    config.onboarding.history_commits = 25;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const baseline = await readFile(
      path.join(recentProjectDir, '.noosphere', 'baseline.md'),
      'utf8',
    );
    const pendingState = JSON.parse(
      await readFile(
        path.join(recentProjectDir, '.noosphere', 'state.json'),
        'utf8',
      ),
    );
    assert.match(baseline, /machine-generated onboarding snapshot/i);
    assert.match(baseline, /initial recent project/);
    assert.match(baseline, /No source file contents or historical diffs/);
    assert.equal(pendingState.baseline.status, 'pending');
    assert.equal(storedActions.length, before);

    await runCli(['baseline'], recentProjectDir);
    assert.equal(storedActions.length, before + 1);
    assert.equal(storedActions.at(-1).action_type, 'project-baseline');
    assert.equal(storedActions.at(-1).project_id, 'recent-project');
    assert.equal(
      storedActions.at(-1).metadata.baseline.source_content_included,
      false,
    );

    await runCli(['baseline'], recentProjectDir);
    assert.equal(storedActions.length, before + 1);
    const storedState = JSON.parse(
      await readFile(
        path.join(recentProjectDir, '.noosphere', 'state.json'),
        'utf8',
      ),
    );
    assert.equal(storedState.baseline.status, 'stored');
    assert.equal(
      storedState.last_workspace_fingerprint,
      storedState.baseline.workspace_fingerprint,
    );
  });

  it('creates a starting baseline even before the first commit', async () => {
    const before = storedActions.length;
    await runCli(['init'], emptyProjectDir);
    const configPath = path.join(
      emptyProjectDir,
      '.noosphere',
      'config.json',
    );
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.project_id = 'empty-project';
    config.relayer_url = serverUrl;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const baseline = await readFile(
      path.join(emptyProjectDir, '.noosphere', 'baseline.md'),
      'utf8',
    );
    assert.match(baseline, /Total commits: 0/);
    assert.match(baseline, /Head: unborn/);
    assert.match(baseline, /No commits available/);

    await runCli(['baseline'], emptyProjectDir);
    assert.equal(storedActions.length, before + 1);
    assert.equal(storedActions.at(-1).project_id, 'empty-project');
    assert.equal(storedActions.at(-1).action_type, 'project-baseline');
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

  it('shares journal entries to Walrus but does not trigger an extra watcher checkpoint', async () => {
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
        'This note is shared to Walrus by default.',
      ]);
      await delay(1_000);
      // Exactly one action: the journal share itself. The watcher must not
      // trigger an additional checkpoint because .noosphere/ edits are excluded
      // from the workspace fingerprint.
      assert.equal(storedActions.length, startingCount + 1);
      assert.equal(storedActions.at(-1)?.action_type, 'note');
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

  it('replaces a wrong local baseline with the typed Walrus baseline during restore', async () => {
    const restoreDir = await mkdtemp(
      path.join(os.tmpdir(), 'noosphere-restore-'),
    );
    const walrusBaseline =
      'PROJECT BASELINE: WALRUS-RESTORE-BASELINE-SENTINEL';
    const walrusMasterPrompt =
      'ORIGINAL TASK: WALRUS-RESTORE-MASTER-SENTINEL';
    const walrusFollowup =
      'LATEST USER INSTRUCTION: WALRUS-RESTORE-FOLLOWUP-SENTINEL';

    try {
      await execFileAsync('git', ['init'], { cwd: restoreDir });
      await runCli(['init'], restoreDir);

      const configPath = path.join(
        restoreDir,
        '.noosphere',
        'config.json',
      );
      const config = JSON.parse(await readFile(configPath, 'utf8'));
      config.project_id = 'continuity-test';
      config.relayer_url = serverUrl;
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

      await writeFile(
        path.join(restoreDir, '.noosphere', 'baseline.md'),
        'WRONG LOCAL BASELINE',
      );
      await writeFile(
        path.join(restoreDir, '.noosphere', 'master-prompt.md'),
        'WRONG LOCAL MASTER PROMPT',
      );
      await writeFile(
        path.join(restoreDir, '.noosphere', 'followups.jsonl'),
        `${JSON.stringify({ content: 'WRONG LOCAL FOLLOWUP' })}\n`,
      );

      typedRecallMemories = [
        {
          action_id: 'baseline-restore-test',
          action_type: 'project-baseline',
          content: walrusBaseline,
          timestamp: '2026-06-15T00:00:00.000Z',
          agent_id: 'restore-test',
        },
        {
          action_id: 'master-restore-test',
          action_type: 'master-prompt',
          content: walrusMasterPrompt,
          timestamp: '2026-06-15T00:00:01.000Z',
          agent_id: 'restore-test',
        },
        {
          action_id: 'followup-restore-test',
          action_type: 'user-followup',
          content: walrusFollowup,
          timestamp: '2026-06-15T00:00:02.000Z',
          agent_id: 'restore-test',
        },
      ];

      const output = await runCli(['restore'], restoreDir);
      assert.match(output, /baseline\.md restored from Walrus/);

      const [baseline, masterPrompt, followups, context] = await Promise.all([
        readFile(path.join(restoreDir, '.noosphere', 'baseline.md'), 'utf8'),
        readFile(
          path.join(restoreDir, '.noosphere', 'master-prompt.md'),
          'utf8',
        ),
        readFile(
          path.join(restoreDir, '.noosphere', 'followups.jsonl'),
          'utf8',
        ),
        readFile(path.join(restoreDir, '.noosphere', 'context.md'), 'utf8'),
      ]);

      assert.equal(baseline, walrusBaseline);
      assert.equal(masterPrompt, walrusMasterPrompt);
      assert.match(followups, /WALRUS-RESTORE-FOLLOWUP-SENTINEL/);
      assert.doesNotMatch(followups, /WRONG LOCAL FOLLOWUP/);
      assert.match(
        context,
        /## Initial project baseline[\s\S]*WALRUS-RESTORE-BASELINE-SENTINEL/,
      );
      assert.doesNotMatch(context, /WRONG LOCAL BASELINE/);

      typedRecallMemories = [];
      await writeFile(
        path.join(restoreDir, '.noosphere', 'baseline.md'),
        'LOCAL BASELINE TO KEEP',
      );
      const noBaselineOutput = await runCli(['restore'], restoreDir);
      assert.match(
        noBaselineOutput,
        /baseline\.md kept local; no Walrus baseline found/,
      );
      assert.equal(
        await readFile(
          path.join(restoreDir, '.noosphere', 'baseline.md'),
          'utf8',
        ),
        'LOCAL BASELINE TO KEEP',
      );
    } finally {
      typedRecallMemories = [];
      await rm(restoreDir, { recursive: true, force: true });
    }
  });

  it('restore surfaces an actionable error when the relayer is unreachable', async () => {
    const restoreDir = await mkdtemp(
      path.join(os.tmpdir(), 'noosphere-restore-down-'),
    );
    try {
      await execFileAsync('git', ['init'], { cwd: restoreDir });
      await runCli(['init'], restoreDir);

      const configPath = path.join(restoreDir, '.noosphere', 'config.json');
      const config = JSON.parse(await readFile(configPath, 'utf8'));
      config.project_id = 'continuity-test';
      config.relayer_url = 'http://127.0.0.1:1';
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

      const child = spawn(process.execPath, [cli, 'restore'], {
        cwd: restoreDir,
        env: {
          ...process.env,
          NOOSPHERE_HOME: lifecycleHome,
          NOOSPHERE_PROJECT_DIR: restoreDir,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stderrChunks = [];
      child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
      const code = await new Promise((resolve) =>
        child.once('close', resolve),
      );
      const stderr = Buffer.concat(stderrChunks).toString();
      assert.notEqual(code, 0, 'restore must fail when the relayer is down');
      assert.match(stderr, /Cannot reach the Noosphere relayer/);
      assert.match(stderr, /noosphere setup --local/);
    } finally {
      await rm(restoreDir, { recursive: true, force: true });
    }
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
  const code = await waitForChild(child, args);
  assert.equal(
    code,
    0,
    `${Buffer.concat(stderr).toString()}\n${Buffer.concat(stdout).toString()}`,
  );
  return Buffer.concat(stdout).toString();
}

function waitForChild(child, args) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(
        new Error(
          `Timed out after ${CLI_TIMEOUT_MS}ms running noosphere ${args.join(' ')}`,
        ),
      );
    }, CLI_TIMEOUT_MS);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
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
