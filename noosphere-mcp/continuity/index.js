#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import {
  access,
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  disableProject,
  noosphereHome,
  readRegistry,
  registerProject,
  pauseProject,
  resumeProject,
  forgetProject,
} from '../lifecycle/registry.js';
import { writeHint } from '../lifecycle/ide-bridge.js';
import { runSetupWizard, runCredentialsCommand } from './credentials-cli.js';
import { runOllamaSession } from './ollama.js';
import { workspaceFingerprintHex as workspaceFingerprint, observeRepository, classifyCompatibility } from './acp/git-state.js';
import { readState, writeState, validateState, buildInitialState } from './acp/store.js';
import { decodeEnvelope } from './acp/wire.js';
import { applyUpdate } from './acp/merge.js';
import { renderKernel } from './acp/render.js';

const execFileAsync = promisify(execFile);
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RELAYER_URL = 'http://127.0.0.1:3001';
const DEFAULT_DEBOUNCE_MS = 8_000;
const DEFAULT_REFRESH_MS = 5 * 60_000;
const DEFAULT_CHECKPOINT_RETRY_MS = 30_000;
const MAX_CHECKPOINT_RETRY_MS = 5 * 60_000;
const DEFAULT_WRITE_TIMEOUT_MS = 130_000;
const DEFAULT_READ_TIMEOUT_MS = 30_000;
const DEFAULT_BASELINE_HISTORY_COMMITS = 50;
const MAX_BASELINE_HISTORY_COMMITS = 200;
const MAX_HANDOFF_BYTES = 1_048_576;
const MANAGED_START = '<!-- noosphere:continuity:start -->';
const MANAGED_END = '<!-- noosphere:continuity:end -->';
const ALL_ADAPTERS = ['codex', 'claude', 'gemini', 'cursor', 'mcp'];

const command = process.argv[2] || 'help';
const explicitProjectPath = readOption('--path');
const projectDir = path.resolve(
  explicitProjectPath ||
    process.env.NOOSPHERE_PROJECT_DIR ||
    process.env.INIT_CWD ||
    '.',
);

try {
  switch (command) {
    case 'init':
      await initializeProject(projectDir);
      break;
    case 'activate':
      await activateProject(projectDir, {
        quiet: process.argv.includes('--quiet'),
      });
      break;
    case 'deactivate':
      await deactivateProject(projectDir);
      break;
    case 'projects':
      await printProjects();
      break;
    case 'install':
    case 'uninstall':
    case 'doctor':
      await runLifecycleCommand(command);
      break;
    case 'watch':
      await watchProject(projectDir);
      break;
    case 'checkpoint':
      await checkpointProject(projectDir, { force: true });
      break;
    case 'baseline':
      await baselineFromCli(projectDir);
      break;
    case 'refresh':
      await refreshContext(projectDir);
      break;
    case 'status':
      await printStatus(projectDir);
      break;
    case 'context':
      await printContext(projectDir);
      break;
    case 'recall':
      await recallFromCli(projectDir);
      break;
    case 'remember':
      await rememberFromCli(projectDir);
      break;
    case 'journal':
      await journalFromCli(projectDir);
      break;
    case 'master-prompt':
      await masterPromptFromCli(projectDir);
      break;
    case 'capture-prompt':
      await capturePromptFromCli(projectDir);
      break;
    case 'share-master-prompt':
      await shareMasterPromptFromCli(projectDir);
      break;
    case 'share-followup-prompt':
      await shareFollowupPromptFromCli(projectDir);
      break;
    case 'ollama':
      await ollamaFromCli(projectDir);
      break;
    case 'protocol':
      await printProtocol(projectDir);
      break;
    case 'register':
      await registerCurrentProject(projectDir);
      break;
    case 'adapters':
      await configureProjectAdapters(
        projectDir,
        parseAdapters(readOption('--only') || process.argv[3]),
      );
      break;
    case 'pause':
      await pauseProject(process.argv[3]);
      console.log(`Paused project ${process.argv[3]}`);
      break;
    case 'resume':
      await resumeProject(process.argv[3]);
      console.log(`Resumed project ${process.argv[3]}`);
      break;
    case 'forget':
      await forgetProject(process.argv[3]);
      console.log(`Forgot project ${process.argv[3]}`);
      break;
    case 'restore':
      await restoreFromWalrus(projectDir);
      break;
    case 'handoff':
      await handoffFromCli(projectDir);
      break;
    case 'state':
      await stateFromCli(projectDir);
      break;
    case 'setup':
      await runSetupWizard();
      break;
    case 'credentials':
      await runCredentialsCommand(process.argv[3]);
      break;
    case 'run-relayer':
      await runForegroundService('relayer');
      break;
    case 'run-manager':
      await runForegroundService('manager');
      break;
    default:
      printHelp();
  }
} catch (error) {
  console.error(`Noosphere continuity: ${error.message}`);
  process.exitCode = 1;
}

export async function initializeProject(root, options = {}) {
  await assertGitRepository(root);
  await mkdir(path.join(root, '.noosphere'), { recursive: true });
  const existing = await readProjectConfig(root);
  const isFirstInitialization = !existing;
  const projectId =
    existing?.project_id || sanitizeProjectId(path.basename(root));
  const adapters =
    options.adapters ||
    existing?.adapters ||
    [];
  const config = {
    project_id: projectId,
    relayer_url: existing?.relayer_url || DEFAULT_RELAYER_URL,
    checkpoint_debounce_ms:
      existing?.checkpoint_debounce_ms || DEFAULT_DEBOUNCE_MS,
    context_refresh_ms:
      normalizeRefreshMs(existing?.context_refresh_ms),
    privacy: {
      checkpoint_content:
        existing?.privacy?.checkpoint_content || 'metadata-only',
      include_diff: existing?.privacy?.include_diff === true,
      share_journal: existing?.privacy?.share_journal !== false,
      capture_master_prompt:
        existing?.privacy?.capture_master_prompt !== false,
    },
    onboarding: {
      auto_baseline:
        existing?.onboarding?.auto_baseline !== false,
      history_commits: normalizeBaselineHistoryLimit(
        existing?.onboarding?.history_commits,
      ),
    },
    adapters,
  };

  await writeProjectConfig(root, config);
  await writeTextIfMissing(
    path.join(root, '.noosphere', 'context.md'),
    emptyContext(projectId),
  );
  await writeTextIfMissing(
    path.join(root, '.noosphere', 'journal.md'),
    journalTemplate(projectId),
  );
  await writeTextIfMissing(
    path.join(root, '.noosphere', 'master-prompt.md'),
    '',
  );
  await writeTextIfMissing(
    path.join(root, '.noosphere', 'followups.jsonl'),
    '',
  );
  await writeUniversalProtocol(root, projectId);
  await writeAgentAdapters(root, projectId, adapters);
  await writeMcpConfigs(root, projectId, adapters);
  await ensureLocalExcludes(root);
  await removeLegacyProjectFiles(root);
  if (isFirstInitialization && config.onboarding.auto_baseline) {
    await prepareAutomaticBaseline(root, config);
  }

  console.log(`Noosphere continuity initialized for ${projectId}.`);
  console.log('The Noosphere project manager will start its watcher.');
}

export async function activateProject(start, { quiet = false } = {}) {
  const root = await findGitRoot(start);
  if (!root) {
    if (!quiet) console.log('Noosphere: current directory is not a Git project.');
    return { skipped: true, reason: 'not-git' };
  }
  if (await exists(path.join(root, '.noosphere-ignore'))) {
    if (!quiet) console.log(`Noosphere: ignored ${root}`);
    return { skipped: true, reason: 'ignored', root };
  }

  const isNew = !(await projectConfigExists(root));
  if (isNew) {
    await initializeProject(root);
  }
  const config = await loadConfig(root);
  await registerProject(root, config.project_id);

  const contextFile = path.join(root, '.noosphere', 'context.md');
  const contextContent = await readFile(contextFile, 'utf8').catch(() => '');
  const contextIsEmpty = !contextContent.trim() || contextContent.includes('No onboarding baseline');
  if (isNew || contextIsEmpty) {
    await refreshContext(root).catch((error) => {
      if (!quiet) {
        console.warn(
          `Noosphere: initial context refresh deferred (${error.message}).`,
        );
      }
    });
  }

  if (!quiet) {
    console.log(`Noosphere active: ${config.project_id} (${root})`);
  }
  return { activated: true, root, project_id: config.project_id };
}

export async function deactivateProject(start) {
  const root = (await findGitRoot(start)) || path.resolve(start);
  await disableProject(root);
  console.log(`Noosphere disabled for ${root}`);
}

/**
 * One-time registration of the current project via the IDE bridge hint file.
 *
 * 1. Finds the Git root of `start`.
 * 2. Reads (or generates) the project_id from `.noosphere/config.json`.
 * 3. Writes `.noosphere/ide-hint.json`.
 * 4. Calls registerProject to add the project to the registry.
 * 5. Prints "Project registered: <project_id>".
 *
 * This enables "one-click Add project" from any terminal inside a GUI IDE.
 */
export async function registerCurrentProject(start) {
  const root = await findGitRoot(path.resolve(start));
  if (!root) {
    throw new Error('Current directory is not inside a Git repository.');
  }

  if (await exists(path.join(root, '.noosphere-ignore'))) {
    throw new Error(`Project is opted out of Noosphere tracking (found .noosphere-ignore).`);
  }

  // Ensure the project has a Noosphere config (init if absent).
  if (!(await projectConfigExists(root))) {
    await initializeProject(root);
  }
  const config = await loadConfig(root);

  // Write the hint file so the IDE bridge can pick this project up
  await writeHint(root, config.project_id);

  // Register immediately in the registry
  await registerProject(root, config.project_id);

  console.log(`Project registered: ${config.project_id}`);
  console.log(`Path: ${root}`);
}

export async function configureProjectAdapters(root, adapters) {
  const config = await loadConfig(root);
  const normalized = adapters || [];
  const next = { ...config, adapters: normalized };
  await writeProjectConfig(root, next);
  await writeUniversalProtocol(root, config.project_id);
  await writeAgentAdapters(root, config.project_id, normalized);
  await writeMcpConfigs(root, config.project_id, normalized);
  await ensureLocalExcludes(root);
  await removeLegacyProjectFiles(root);
  console.log(
    normalized.length > 0
      ? `Noosphere adapters enabled: ${normalized.join(', ')}`
      : 'Noosphere adapters disabled. Core memory remains in .noosphere/.',
  );
}

async function printProjects() {
  const registry = await readRegistry();
  console.log(JSON.stringify(registry.projects, null, 2));
}

async function runForegroundService(kind) {
  const home = noosphereHome();
  const targets = {
    relayer: {
      label: 'noosphere-relayer',
      entry: path.join(home, 'app', 'noosphere-relayer', 'index.js'),
      cwd: path.join(home, 'app', 'noosphere-relayer'),
    },
    manager: {
      label: 'noosphere-manager',
      entry: path.join(home, 'app', 'noosphere-mcp', 'lifecycle', 'manager.js'),
      cwd: path.join(home, 'app', 'noosphere-mcp'),
    },
  };
  const target = targets[kind];
  if (!target) {
    throw new Error(`Unknown foreground service: ${kind}`);
  }
  try {
    await access(target.entry);
  } catch {
    throw new Error(
      `${target.entry} is missing. Run install:user first, or set ` +
      'NOOSPHERE_HOME if the runtime lives elsewhere.',
    );
  }
  console.log(`Starting ${target.label} in foreground.`);
  console.log('Press Ctrl+C to stop.');
  const child = spawn(process.execPath, [target.entry], {
    cwd: target.cwd,
    stdio: 'inherit',
    env: process.env,
  });
  const forward = (signal) => () => child.kill(signal);
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) process.exitCode = 0;
      else process.exitCode = code ?? 0;
      resolve();
    });
  });
}

async function runLifecycleCommand(action) {
  const installer = path.resolve(
    moduleDirectory,
    '..',
    'lifecycle',
    'install.js',
  );
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [installer, action],
      {
        env: process.env,
        maxBuffer: 2_000_000,
      },
    );
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
  } catch (error) {
    if (error.stdout) process.stdout.write(error.stdout);
    if (error.stderr) process.stderr.write(error.stderr);
    throw new Error(
      `${action} reported one or more failed checks`,
      { cause: error },
    );
  }
}

export async function watchProject(root, options = {}) {
  await assertGitRepository(root);
  const config = await loadConfig(root);
  const debounceMs =
    options.debounceMs || config.checkpoint_debounce_ms;
  const refreshMs =
    options.refreshMs || config.context_refresh_ms;
  let lastFingerprint = await workspaceFingerprint(root);
  const previousState =
    (await readJson(path.join(root, '.noosphere', 'state.json'))) || {};
  let baselinePending =
    previousState.baseline?.status === 'pending';
  let baselineRunning = false;
  let baselineRetryAt = Date.now();
  let pendingSince =
    baselinePending ||
    previousState.last_workspace_fingerprint === lastFingerprint
      ? null
      : Date.now();
  let checkpointDelayMs = debounceMs;
  let retryDelayMs =
    Number(process.env.NOOSPHERE_CHECKPOINT_RETRY_BASE_MS) ||
    DEFAULT_CHECKPOINT_RETRY_MS;
  const maxRetryDelayMs =
    Number(process.env.NOOSPHERE_CHECKPOINT_RETRY_MAX_MS) ||
    MAX_CHECKPOINT_RETRY_MS;
  let checkpointRunning = false;
  let refreshRunning = false;

  console.log(
    `Noosphere continuity watching ${config.project_id} (${config.privacy.checkpoint_content}).`,
  );
  await refreshContext(root).catch(logBackgroundError);

  const pollTimer = setInterval(async () => {
    try {
      const fingerprint = await workspaceFingerprint(root);
      if (fingerprint !== lastFingerprint) {
        lastFingerprint = fingerprint;
        pendingSince = Date.now();
        checkpointDelayMs = debounceMs;
      }
      if (
        baselinePending &&
        !baselineRunning &&
        Date.now() >= baselineRetryAt
      ) {
        baselineRunning = true;
        try {
          const stored = await storePreparedBaseline(root);
          baselinePending = false;
          retryDelayMs =
            Number(process.env.NOOSPHERE_CHECKPOINT_RETRY_BASE_MS) ||
            DEFAULT_CHECKPOINT_RETRY_MS;
          pendingSince =
            fingerprint === stored.workspaceFingerprint
              ? null
              : Date.now();
        } catch (error) {
          baselineRetryAt = Date.now() + retryDelayMs;
          retryDelayMs = Math.min(retryDelayMs * 2, maxRetryDelayMs);
          logBackgroundError(error);
        } finally {
          baselineRunning = false;
        }
      }
      if (baselinePending) return;
      if (
        pendingSince &&
        Date.now() - pendingSince >= checkpointDelayMs &&
        !checkpointRunning
      ) {
        checkpointRunning = true;
        pendingSince = null;
        try {
          await checkpointProject(root);
          retryDelayMs =
            Number(process.env.NOOSPHERE_CHECKPOINT_RETRY_BASE_MS) ||
            DEFAULT_CHECKPOINT_RETRY_MS;
          checkpointDelayMs = debounceMs;
        } catch (error) {
          pendingSince = Date.now();
          checkpointDelayMs = retryDelayMs;
          retryDelayMs = Math.min(retryDelayMs * 2, maxRetryDelayMs);
          logBackgroundError(error);
        } finally {
          checkpointRunning = false;
        }
      }
    } catch (error) {
      logBackgroundError(error);
    }
  }, Math.min(2_000, Math.max(500, Math.floor(debounceMs / 4))));

  const refreshTimer = setInterval(async () => {
    if (refreshRunning) return;
    refreshRunning = true;
    try {
      await refreshContext(root);
    } catch (error) {
      logBackgroundError(error);
    } finally {
      refreshRunning = false;
    }
  }, refreshMs);

  await new Promise((resolve) => {
    const stop = () => {
      clearInterval(pollTimer);
      clearInterval(refreshTimer);
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

async function prepareAutomaticBaseline(root, config) {
  const profile = await inspectRepositoryHistory(
    root,
    config.onboarding.history_commits,
  );

  const prepared = await prepareProjectBaseline(root, {
    config,
    profile,
  });
  console.log(
    `Prepared initial project baseline from ` +
      `${profile.total_commits} commits.`,
  );
  return prepared;
}

export async function prepareProjectBaseline(root, options = {}) {
  const config = options.config || await loadConfig(root);
  const statePath = path.join(root, '.noosphere', 'state.json');
  const state = (await readJson(statePath)) || {};
  if (state.baseline && !options.force) {
    return {
      skipped: true,
      status: state.baseline.status,
      workspaceFingerprint: state.baseline.workspace_fingerprint,
    };
  }

  const historyLimit = normalizeBaselineHistoryLimit(
    options.historyLimit || config.onboarding.history_commits,
  );
  const profile =
    options.profile ||
    await inspectRepositoryHistory(root, historyLimit);
  const snapshot = await buildWorkspaceSnapshot(root, config);
  const baseline = buildProjectBaseline(config.project_id, profile, snapshot);
  const fingerprint = hash(baseline);
  const generatedAt = new Date().toISOString();

  await writeFile(
    path.join(root, '.noosphere', 'baseline.md'),
    baseline,
    'utf8',
  );
  await writeJson(statePath, {
    ...state,
    baseline: {
      status: 'pending',
      fingerprint,
      generated_at: generatedAt,
      workspace_fingerprint: snapshot.workspace_fingerprint,
      history_commits: profile.recent_commits.length,
      total_commits: profile.total_commits,
      oldest_commit_at: profile.oldest_commit_at,
      newest_commit_at: profile.newest_commit_at,
    },
  });

  return {
    prepared: true,
    fingerprint,
    profile,
    workspaceFingerprint: snapshot.workspace_fingerprint,
  };
}

export async function storePreparedBaseline(root) {
  const config = await loadConfig(root);
  const statePath = path.join(root, '.noosphere', 'state.json');
  const state = (await readJson(statePath)) || {};
  const baselineState = state.baseline;
  if (!baselineState) {
    throw new Error('No project baseline is prepared.');
  }
  if (baselineState.status === 'stored') {
    return {
      skipped: true,
      blob_id: baselineState.blob_id || null,
      workspaceFingerprint: baselineState.workspace_fingerprint,
    };
  }

  const content = await readFile(
    path.join(root, '.noosphere', 'baseline.md'),
    'utf8',
  );
  const response = await requestJson(
    `${config.relayer_url}/v1/actions`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `baseline-${baselineState.fingerprint}`,
      },
      body: JSON.stringify({
        project_id: config.project_id,
        agent_id: 'project-onboarding',
        action_type: 'project-baseline',
        content,
        session_id: `baseline-${baselineState.fingerprint.slice(0, 16)}`,
        provider: null,
        model: null,
        client: 'noosphere-baseline',
        metadata: {
          baseline: {
            fingerprint: baselineState.fingerprint,
            generated_at: baselineState.generated_at,
            total_commits: baselineState.total_commits,
            history_commits: baselineState.history_commits,
            oldest_commit_at: baselineState.oldest_commit_at,
            newest_commit_at: baselineState.newest_commit_at,
            source_content_included: false,
            source_diffs_included: false,
          },
        },
      }),
    },
  );
  const storedAt = new Date().toISOString();
  await writeJson(statePath, {
    ...state,
    baseline: {
      ...baselineState,
      status: response.pending ? 'queued' : 'stored',
      stored_at: storedAt,
      blob_id: response.blob_id || baselineState.blob_id || null,
    },
    last_blob_id: response.blob_id || state.last_blob_id || null,
    last_workspace_fingerprint:
      baselineState.workspace_fingerprint,
  });

  const disposition = response.pending ? 'queued' : 'stored';
  console.log(
    `Noosphere project baseline ${disposition} for ${config.project_id}.`,
  );
  return {
    ...response,
    workspaceFingerprint: baselineState.workspace_fingerprint,
  };
}

async function baselineFromCli(root) {
  await assertGitRepository(root);
  if (!(await projectConfigExists(root))) {
    await initializeProject(root);
  }
  const historyLimit = normalizeBaselineHistoryLimit(
    readFlag('--commits'),
  );
  const force = process.argv.includes('--force');
  const prepared = await prepareProjectBaseline(root, {
    force,
    historyLimit,
  });
  if (prepared.skipped && prepared.status === 'stored') {
    console.log(
      'A project baseline is already stored. Use --force to replace it.',
    );
    return prepared;
  }
  return storePreparedBaseline(root);
}

export async function checkpointProject(root, { force = false } = {}) {
  const config = await loadConfig(root);
  const snapshot = await buildWorkspaceSnapshot(root, config);
  const statePath = path.join(root, '.noosphere', 'state.json');
  const state = (await readJson(statePath)) || {};
  const fingerprint = checkpointFingerprint(snapshot);

  if (!force
      && state.last_checkpoint_fingerprint === fingerprint
      && !state.pending_checkpoint_fingerprint) {
    return { skipped: true };
  }

  const agentId =
    process.env.NOOSPHERE_AGENT_ID || 'workspace-continuity';
  const payload = {
    project_id: config.project_id,
    agent_id: agentId,
    action_type: 'checkpoint',
    content: formatCheckpoint(snapshot),
    session_id:
      process.env.NOOSPHERE_SESSION_ID || `workspace-${Date.now()}`,
    provider: process.env.NOOSPHERE_PROVIDER || null,
    model: process.env.NOOSPHERE_MODEL || null,
    client: process.env.NOOSPHERE_CLIENT || 'filesystem-watcher',
    metadata: {
      checkpoint: snapshot,
      privacy: config.privacy,
    },
  };
  const acceptedWorkspaceFingerprint = snapshot.workspace_fingerprint;
  const response = await requestJson(
    `${config.relayer_url}/v1/actions`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `checkpoint-${fingerprint}`,
      },
      body: JSON.stringify(payload),
    },
  );

  await writeJson(statePath, {
    ...state,
    ...(response.pending
      ? { pending_checkpoint_fingerprint: fingerprint }
      : {
          last_checkpoint_fingerprint: fingerprint,
          pending_checkpoint_fingerprint: null,
        }),
    last_checkpoint_at: new Date().toISOString(),
    last_blob_id: response.blob_id || state.last_blob_id || null,
    last_checkpoint_pending: response.pending === true,
    last_workspace_fingerprint: acceptedWorkspaceFingerprint,
  });
  const disposition = response.pending ? 'queued' : 'stored';
  console.log(
    `Noosphere checkpoint ${disposition} for ${config.project_id}: ` +
      `${snapshot.changed_files.length} changed files.`,
  );
  return response;
}

export function checkpointFingerprint(snapshot) {
  const { captured_at: _capturedAt, ...stableSnapshot } = snapshot;
  return hash(JSON.stringify(stableSnapshot));
}

export async function refreshContext(root, options = {}) {
  const config = await loadConfig(root);
  const query = encodeURIComponent(
    options.query ||
      'latest project changes failures decisions blockers tests and next steps',
  );
  const context = await requestText(
    `${config.relayer_url}/v1/projects/${encodeURIComponent(
      config.project_id,
    )}/context?format=text&limit=50&q=${query}`,
  );
  let baseline = await readFile(
    path.join(root, '.noosphere', 'baseline.md'),
    'utf8',
  ).catch(() => '');
  let masterPrompt = await readMasterPrompt(root);
  let followups = await readFollowupPrompts(root);

  if (!baseline || !masterPrompt || followups.length === 0) {
    const walrusRestore = await recallTypedMemories(config, {
      baseline: !baseline,
      masterPrompt: !masterPrompt,
      followups: followups.length === 0,
    });
    if (!baseline && walrusRestore.baseline) baseline = walrusRestore.baseline;
    if (!masterPrompt && walrusRestore.masterPrompt) masterPrompt = walrusRestore.masterPrompt;
    if (followups.length === 0 && walrusRestore.followups.length > 0) followups = walrusRestore.followups;
  }
  const output = [
    '# Noosphere shared context',
    '',
    `Project: ${config.project_id}`,
    `Refreshed: ${new Date().toISOString()}`,
    '',
    'Read this before changing the project. It may contain work from another AI tool.',
    '',
    baseline
      ? [
          '## Initial project baseline',
          '',
          baseline
            .replace(/^# Noosphere project baseline\s*/i, '')
            .trim(),
        ].join('\n')
      : '## Initial project baseline\n\nNo onboarding baseline has been created.',
    '',
    masterPrompt
      ? [
          '## Pinned master prompt',
          '',
          'This is the original project instruction. Preserve its phases and constraints.',
          '',
          masterPrompt,
        ].join('\n')
      : '## Pinned master prompt\n\nNo master prompt has been recorded.',
    '',
    '## Follow-up user instructions',
    '',
    followups.length > 0
      ? formatFollowupPrompts(followups)
      : 'No follow-up prompts have been recorded.',
    '',
    '## Completion evidence',
    '',
    'Verify completion claims against the current working tree and tests.',
    '',
    await formatLocalJournal(root),
    '',
    '## Semantically recalled shared history',
    '',
    '```text',
    context.trim(),
    '```',
  ].join('\n');
  await atomicWrite(path.join(root, '.noosphere', 'context.md'), output);
  return output;
}

async function recallTypedMemories(config, { baseline, masterPrompt, followups }) {
  const result = { baseline: '', masterPrompt: '', followups: [] };
  const projectId = encodeURIComponent(config.project_id);
  const base = `${config.relayer_url}/v1/projects/${projectId}/recall`;

  async function fetchByType(query, actionType, limit = 1) {
    return requestJson(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, limit, action_type: actionType }),
    });
  }

  const [baselineRes, masterPromptRes, followupsRes] = await Promise.all([
    baseline ? fetchByType('project baseline git history', 'project-baseline') : null,
    masterPrompt ? fetchByType('master prompt original project instruction', 'master-prompt') : null,
    followups ? fetchByType('follow-up user instructions', 'user-followup', 50) : null,
  ]);

  if (baselineRes?.memories?.length > 0) {
    result.baseline = baselineRes.memories[0].content || '';
  }
  if (masterPromptRes?.memories?.length > 0) {
    result.masterPrompt = masterPromptRes.memories[0].content || '';
  }
  if (followupsRes?.memories?.length > 0) {
    result.followups = followupsRes.memories
      .map((m) => ({
        timestamp: m.timestamp || new Date().toISOString(),
        source: m.agent_id || 'walrus-restore',
        agent_id: m.agent_id || 'walrus-restore',
        hash: m.action_id || '',
        content: m.content || '',
      }))
      .sort((a, b) => (a.timestamp > b.timestamp ? 1 : -1));
  }
  return result;
}

export async function buildWorkspaceSnapshot(root, config) {
  const [branch, head, status, diffStat] = await Promise.all([
    git(root, ['branch', '--show-current']),
    git(root, ['rev-parse', '--short', 'HEAD']).catch(() => 'unborn'),
    git(root, ['status', '--porcelain=v1']),
    git(root, ['diff', '--stat', '--', '.']),
  ]);
  const changedFiles = status
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter((file) => !file.startsWith('.noosphere/'))
    .slice(0, 200);
  const snapshot = {
    branch: branch || 'detached',
    head,
    changed_files: changedFiles,
    diff_stat: diffStat || 'No tracked diff statistics available.',
    workspace_fingerprint: await workspaceFingerprint(root),
    captured_at: new Date().toISOString(),
    raw_diff_included: config.privacy.include_diff,
    journal_present: await fileHasJournalEntries(root),
  };

  if (config.privacy.include_diff) {
    snapshot.diff = (
      await git(root, ['diff', '--no-ext-diff', '--unified=1', '--', '.'])
    ).slice(0, 30_000);
  }
  if (config.privacy.share_journal) {
    snapshot.public_work_journal = (
      await readFile(path.join(root, '.noosphere', 'journal.md'), 'utf8')
    ).slice(-20_000);
  }
  return snapshot;
}

export async function inspectRepositoryHistory(
  root,
  historyLimit = DEFAULT_BASELINE_HISTORY_COMMITS,
) {
  const limit = normalizeBaselineHistoryLimit(historyLimit);
  const [
    countText,
    oldestText,
    newestText,
    recentText,
    trackedText,
  ] = await Promise.all([
    git(root, ['rev-list', '--count', 'HEAD']).catch(() => '0'),
    git(root, [
      'log',
      '--max-parents=0',
      '--format=%cI',
      'HEAD',
    ]).catch(() => ''),
    git(root, ['log', '-1', '--format=%cI', 'HEAD']).catch(() => ''),
    git(root, [
      'log',
      `-${limit}`,
      '--date=short',
      '--format=%h%x09%ad%x09%s',
      'HEAD',
    ]).catch(() => ''),
    git(root, ['ls-files']).catch(() => ''),
  ]);
  const trackedFiles = trackedText.split('\n').filter(Boolean);
  const topLevel = new Map();
  for (const file of trackedFiles) {
    const area = file.includes('/') ? file.split('/')[0] : '(root)';
    topLevel.set(area, (topLevel.get(area) || 0) + 1);
  }
  const recentCommits = recentText
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hashValue, date, ...subject] = line.split('\t');
      return {
        hash: hashValue,
        date,
        subject: subject.join('\t'),
      };
    });
  return {
    total_commits: Number(countText) || 0,
    oldest_commit_at: oldestText.split('\n').filter(Boolean)[0] || null,
    newest_commit_at: newestText || null,
    tracked_files: trackedFiles.length,
    top_level_areas: [...topLevel.entries()]
      .map(([name, files]) => ({ name, files }))
      .sort((a, b) => b.files - a.files || a.name.localeCompare(b.name))
      .slice(0, 30),
    recent_commits: recentCommits,
  };
}

export function buildProjectBaseline(projectId, profile, snapshot) {
  const changedFiles =
    snapshot.changed_files.length > 0
      ? snapshot.changed_files.join(', ')
      : 'None';
  const areas =
    profile.top_level_areas.length > 0
      ? profile.top_level_areas
          .map((area) => `- ${area.name}: ${area.files} tracked files`)
          .join('\n')
      : '- No tracked files';
  const history =
    profile.recent_commits.length > 0
      ? profile.recent_commits
          .map(
            (commit) =>
              `- ${commit.date} ${commit.hash}: ${commit.subject}`,
          )
          .join('\n')
      : '- No commits available';

  return `# Noosphere project baseline

Project: ${projectId}
Generated: ${snapshot.captured_at}

This is a machine-generated onboarding snapshot of the repository at the
moment Noosphere was first activated.
It is evidence, not a substitute for the current files, tests, or maintainer
knowledge. Future agents must verify historical claims before relying on them.

## Repository history

- Total commits: ${profile.total_commits}
- Oldest commit: ${profile.oldest_commit_at || 'Unknown'}
- Newest commit: ${profile.newest_commit_at || 'Unknown'}
- Recent commits included: ${profile.recent_commits.length}

## Current state

- Branch: ${snapshot.branch}
- Head: ${snapshot.head}
- Changed files at onboarding: ${changedFiles}
- Tracked files: ${profile.tracked_files}
- Workspace fingerprint: ${snapshot.workspace_fingerprint}

## Project structure

${areas}

## Recent Git history

${history}

## Privacy boundary

No source file contents or historical diffs are included. This baseline contains
repository metadata, file-area counts, changed paths, and recent commit subjects.
`;
}

async function printStatus(root) {
  const config = await loadConfig(root);
  const state = await readJson(
    path.join(root, '.noosphere', 'state.json'),
  );
  console.log(
    JSON.stringify(
      {
        project: config.project_id,
        relayer: config.relayer_url,
        privacy: config.privacy,
        onboarding: config.onboarding,
        baseline: state?.baseline || null,
        last_checkpoint_at: state?.last_checkpoint_at || null,
        last_blob_id: state?.last_blob_id || null,
      },
      null,
      2,
    ),
  );
}

async function writeMcpConfigs(root, projectId, adapters) {
  const namespace = `noosphere-${sanitizeProjectId(projectId)}`;
  const server = {
    command: 'npx',
    args: [
      '-y',
      '@mysten-incubation/memwal-mcp@0.0.4',
      '--staging',
      '--namespace',
      namespace,
    ],
  };
  const selected = new Set(adapters);
  const genericMcp = path.join(root, '.mcp.json');
  if (selected.has('mcp')) {
    await upsertMcpServer(genericMcp, server);
  } else {
    await removeMcpServer(genericMcp);
  }

  const cursorDirectory = path.join(root, '.cursor');
  const cursorMcp = path.join(cursorDirectory, 'mcp.json');
  if (selected.has('cursor')) {
    await mkdir(cursorDirectory, { recursive: true });
    await upsertMcpServer(cursorMcp, server);
  } else {
    await removeMcpServer(cursorMcp);
  }
  await removeEmptyDirectory(cursorDirectory);
}

async function writeAgentAdapters(root, projectId, adapters) {
  const shared = `${MANAGED_START}
## Noosphere continuity adapter

Noosphere's core protocol is vendor-neutral. This file is an auto-load adapter
for tools that recognize this filename.

1. Before working, read \`.noosphere/baseline.md\` if present,
   \`.noosphere/master-prompt.md\`, \`.noosphere/followups.jsonl\`,
   \`.noosphere/context.md\`, and \`.noosphere/journal.md\`.
   If \`.noosphere/context.md\` is absent or empty, run \`noosphere context\`
   (or \`GET /v1/projects/${sanitizeProjectId(projectId)}/bootstrap\`) to
   reconstruct it from Walrus before proceeding.
2. Treat the master prompt as pinned project intent. Preserve unfinished
   phases and constraints unless the user explicitly changes them.
3. Inspect the working tree because another tool may have changed it.
4. Append concise findings, evidence, decisions, failed approaches, and
   handoffs to \`.noosphere/journal.md\`.
5. Do not record hidden chain-of-thought, secrets, or private internal
   reasoning.

Project namespace: \`noosphere-${sanitizeProjectId(projectId)}\`.
${MANAGED_END}`;
  const selected = new Set(adapters);
  const files = {
    codex: path.join(root, 'AGENTS.md'),
    claude: path.join(root, 'CLAUDE.md'),
    gemini: path.join(root, 'GEMINI.md'),
  };
  for (const [adapter, file] of Object.entries(files)) {
    if (selected.has(adapter)) {
      await upsertManagedBlock(file, shared);
    } else {
      await removeManagedBlock(file);
    }
  }

  const cursorDirectory = path.join(root, '.cursor');
  const cursorRules = path.join(cursorDirectory, 'rules');
  const cursorRule = path.join(cursorRules, 'noosphere.mdc');
  if (selected.has('cursor')) {
    await mkdir(cursorRules, { recursive: true });
    await writeFile(
      cursorRule,
      `---
description: Load the universal Noosphere continuity protocol
alwaysApply: true
---

Read \`.noosphere/instructions.md\`, \`.noosphere/baseline.md\` if present,
\`.noosphere/master-prompt.md\`, \`.noosphere/followups.jsonl\`,
\`.noosphere/context.md\`, and \`.noosphere/journal.md\` before working. Treat
the master prompt plus ordered follow-ups as current project intent and
preserve unfinished phases. Append concise, verifiable findings and handoffs
to the journal. Do not write hidden chain-of-thought.
`,
      'utf8',
    );
  } else {
    await rm(cursorRule, { force: true });
    await removeEmptyDirectory(cursorRules);
  }
  await removeEmptyDirectory(cursorDirectory);
}

async function ensureLocalExcludes(root) {
  const exclude = path.join(root, '.git', 'info', 'exclude');
  let current = '';
  try {
    current = await readFile(exclude, 'utf8');
  } catch {
    // git init normally creates this file, but creating it is harmless.
  }
  const entries = [
    '.noosphere/baseline.md',
    '.noosphere/context.md',
    '.noosphere/journal.md',
    '.noosphere/master-prompt.md',
    '.noosphere/followups.jsonl',
    '.noosphere/state.json',
    '.noosphere/*.tmp',
    '._*',
    '**/._*',
    '.DS_Store',
  ];
  const missing = entries.filter(
    (entry) => !current.split(/\r?\n/).includes(entry),
  );
  if (missing.length > 0) {
    await mkdir(path.dirname(exclude), { recursive: true });
    await appendFile(
      exclude,
      `${current && !current.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`,
      'utf8',
    );
  }
}

async function upsertManagedBlock(file, block) {
  let current = '';
  try {
    current = await readFile(file, 'utf8');
  } catch {
    // Create the adapter when the tool-specific file is absent.
  }
  const pattern = new RegExp(
    `${escapeRegExp(MANAGED_START)}[\\s\\S]*?${escapeRegExp(MANAGED_END)}`,
  );
  const next = pattern.test(current)
    ? current.replace(pattern, block)
    : `${current.trimEnd()}${current.trim() ? '\n\n' : ''}${block}\n`;
  await writeFile(file, next, 'utf8');
}

async function removeManagedBlock(file) {
  let current;
  try {
    current = await readFile(file, 'utf8');
  } catch {
    return;
  }
  const pattern = new RegExp(
    `${escapeRegExp(MANAGED_START)}[\\s\\S]*?${escapeRegExp(MANAGED_END)}\\n?`,
  );
  if (!pattern.test(current)) return;
  const next = current.replace(pattern, '').trim();
  if (next) {
    await writeFile(file, `${next}\n`, 'utf8');
  } else {
    await rm(file, { force: true });
  }
}

async function upsertMcpServer(file, server) {
  const current = (await readJson(file)) || {};
  await writeJson(file, {
    ...current,
    mcpServers: {
      ...(current.mcpServers || {}),
      noosphere: server,
    },
  });
}

async function removeMcpServer(file) {
  const current = await readJson(file);
  if (!current?.mcpServers?.noosphere) return;
  const mcpServers = { ...current.mcpServers };
  delete mcpServers.noosphere;
  const next = { ...current, mcpServers };
  if (Object.keys(mcpServers).length === 0 && Object.keys(next).length === 1) {
    await rm(file, { force: true });
  } else {
    await writeJson(file, next);
  }
}

async function removeEmptyDirectory(directory) {
  await rmdir(directory).catch((error) => {
    if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error;
  });
}

async function loadConfig(root) {
  const config = await readProjectConfig(root);
  if (!config?.project_id) {
    throw new Error('Run `node continuity/index.js init` in this project first.');
  }
  return {
    ...config,
    relayer_url:
      config.relayer_url ||
      process.env.NOOSPHERE_RELAYER_URL ||
      DEFAULT_RELAYER_URL,
    checkpoint_debounce_ms:
      config.checkpoint_debounce_ms || DEFAULT_DEBOUNCE_MS,
    context_refresh_ms:
      normalizeRefreshMs(config.context_refresh_ms),
    adapters: Array.isArray(config.adapters)
      ? config.adapters
      : [],
    privacy: {
      checkpoint_content:
        config.privacy?.checkpoint_content || 'metadata-only',
      include_diff: config.privacy?.include_diff === true,
      share_journal: config.privacy?.share_journal !== false,
      capture_master_prompt:
        config.privacy?.capture_master_prompt !== false,
    },
    onboarding: {
      auto_baseline:
        config.onboarding?.auto_baseline !== false,
      history_commits: normalizeBaselineHistoryLimit(
        config.onboarding?.history_commits,
      ),
    },
  };
}

function formatCheckpoint(snapshot) {
  const files =
    snapshot.changed_files.length > 0
      ? snapshot.changed_files.join(', ')
      : 'No changed files';
  return [
    `Automatic workspace checkpoint on ${snapshot.branch} at ${snapshot.head}.`,
    `Changed files: ${files}.`,
    `Diff summary:\n${snapshot.diff_stat}`,
    snapshot.raw_diff_included
      ? `Diff excerpt:\n${snapshot.diff}`
      : 'Raw source diff was not uploaded (privacy mode: metadata-only).',
    snapshot.journal_present
      ? snapshot.public_work_journal
        ? `Public work journal:\n${snapshot.public_work_journal}`
        : 'The local public work journal changed but was not uploaded (privacy.share_journal=false).'
      : 'No public work journal entries are present.',
  ].join('\n\n');
}

async function printContext(root) {
  const file = path.join(root, '.noosphere', 'context.md');
  try {
    process.stdout.write(await readFile(file, 'utf8'));
  } catch {
    process.stdout.write(await refreshContext(root));
  }
}

async function recallFromCli(root) {
  const config = await loadConfig(root);
  const query =
    readFlag('--query') ||
    process.argv.slice(3).filter((value) => !value.startsWith('--')).join(' ') ||
    'latest project state decisions failures and next steps';
  const url = `${config.relayer_url}/v1/projects/${encodeURIComponent(
    config.project_id,
  )}/context?format=text&limit=50&q=${encodeURIComponent(query)}`;
  process.stdout.write(`${await requestText(url)}\n`);
}

async function rememberFromCli(root) {
  const config = await loadConfig(root);
  const content = await readCliContent();
  const response = await storeCliMemory(config, {
    content,
    actionType: readFlag('--type') || 'memory',
    agentId: readFlag('--agent') || process.env.NOOSPHERE_AGENT_ID || 'cli-agent',
    client: readFlag('--client') || 'generic-cli',
  });
  process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
}

async function journalFromCli(root) {
  const config = await loadConfig(root);
  const content = await readCliContent();
  const agentId =
    readFlag('--agent') || process.env.NOOSPHERE_AGENT_ID || 'cli-agent';
  const actionType = readFlag('--type') || 'note';
  const entry = [
    `## ${new Date().toISOString()} — ${agentId} / ${actionType}`,
    '',
    content,
    '',
  ].join('\n');
  await appendFile(path.join(root, '.noosphere', 'journal.md'), entry, 'utf8');

  if (config.privacy.share_journal || process.argv.includes('--share')) {
    await storeCliMemory(config, {
      content,
      actionType,
      agentId,
      client: readFlag('--client') || 'work-journal',
    });
    console.log('Journal entry appended and shared.');
  } else {
    console.log('Journal entry appended locally.');
  }
}

async function masterPromptFromCli(root) {
  const existing = await readMasterPrompt(root);
  const hasInput =
    Boolean(readFlag('--content')) ||
    contentPositionals().length > 0 ||
    !process.stdin.isTTY;

  if (!hasInput) {
    if (!existing) {
      console.log('No master prompt has been captured for this project.');
      return;
    }
    process.stdout.write(existing);
    if (!existing.endsWith('\n')) process.stdout.write('\n');
    return;
  }

  const content = await readExactCliContent();
  const result = await captureMasterPrompt(root, content, {
    force: process.argv.includes('--replace'),
    automatic: false,
    source: readFlag('--source') || 'explicit-cli',
    agentId:
      readFlag('--agent') ||
      process.env.NOOSPHERE_AGENT_ID ||
      'project-owner',
  });
  printMasterPromptResult(result);
}

async function handoffFromCli(root) {
  await assertGitRepository(root);
  const clock = new Date().toISOString();
  const raw = await readHandoffSource();
  const update = decodeEnvelope(raw, { clock });
  if (!update.ok) {
    throw new Error(`Invalid ACP handoff: ${formatAcpErrors(update.errors)}`);
  }
  const current = await readState(root, { clock });
  if (current && !current.ok) {
    throw new Error(
      `Refusing to overwrite unreadable .noosphere/continuity.json: ${formatAcpErrors(current.errors)}. `
        + 'Repair or remove it before importing a handoff.',
    );
  }
  let next;
  if (current) {
    const merged = applyUpdate(current.state, update.state, { clock });
    if (!merged.ok) throw new Error(`Cannot merge handoff: ${formatAcpErrors(merged.errors)}`);
    next = merged;
  } else {
    next = { state: update.state, conflicts: update.state.runtime.conflicts };
  }
  const written = await writeState(root, next.state, { clock });
  const conflicts = next.conflicts ?? [];
  console.log(`ACP handoff stored (${written.envelope.snapshot_id}).`);
  if (conflicts.length) {
    console.log(`${conflicts.length} unresolved conflict(s); run \`noosphere state --json\` to review.`);
  }
}

async function stateFromCli(root) {
  await assertGitRepository(root);
  const clock = new Date().toISOString();
  const mode = process.argv[3];
  if (mode === 'validate') {
    const result = await validateState(root, { clock });
    if (result.ok) {
      console.log('ACP state is valid.');
      return;
    }
    console.error(`ACP state invalid: ${formatAcpErrors(result.errors)}`);
    process.exitCode = 1;
    return;
  }
  const existing = await readState(root, { clock });
  if (existing && !existing.ok) {
    throw new Error(`Unreadable .noosphere/continuity.json: ${formatAcpErrors(existing.errors)}.`);
  }
  const decoded = existing ?? await buildInitialState(root, { clock });
  if (!decoded.ok) throw new Error(`Cannot build ACP state: ${formatAcpErrors(decoded.errors)}`);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(decoded.state.envelope, null, 2));
    return;
  }
  const compatibility = classifyCompatibility(decoded.state, await observeRepository(root));
  console.log(renderKernel(decoded.state, { compatibility, snapshotId: decoded.state.envelope.snapshot_id }));
}

async function readHandoffSource() {
  const file = readOption('--file');
  const useStdin = process.argv.includes('--stdin');
  if (file && useStdin) throw new Error('Provide exactly one of --file or --stdin.');
  if (file) {
    const resolved = path.resolve(file);
    const details = await stat(resolved);
    if (details.size > MAX_HANDOFF_BYTES) {
      throw new Error(`ACP handoff file exceeds ${MAX_HANDOFF_BYTES} bytes.`);
    }
    return readFile(resolved, 'utf8');
  }
  if (useStdin || !process.stdin.isTTY) {
    const chunks = [];
    let total = 0;
    for await (const chunk of process.stdin) {
      total += chunk.length;
      if (total > MAX_HANDOFF_BYTES) {
        throw new Error(`ACP handoff exceeds ${MAX_HANDOFF_BYTES} bytes.`);
      }
      chunks.push(chunk);
    }
    const piped = Buffer.concat(chunks).toString('utf8');
    if (piped.trim()) return piped;
  }
  throw new Error('Provide an ACP handoff with --file <path> or --stdin.');
}

function formatAcpErrors(errors) {
  return (errors ?? []).map((error) => `${error.path} ${error.code}`).join('; ') || 'unknown error';
}

async function restoreFromWalrus(root) {
  const config = await loadConfig(root);
  console.log(`Restoring project state from Walrus for ${config.project_id}...`);

  if (!(await pingRelayer(config.relayer_url))) {
    throw relayerDownError(config.relayer_url);
  }

  let recalled;
  try {
    recalled = await recallTypedMemories(config, {
      baseline: true,
      masterPrompt: true,
      followups: true,
    });
  } catch (error) {
    throw new Error(
      [
        `Walrus recall failed: ${error.message}`,
        '',
        'Confirm credentials are present:',
        '  noosphere credentials status',
        '',
        'Or switch to local-only mode without Walrus:',
        '  noosphere setup --demo',
      ].join('\n'),
    );
  }

  let restored = 0;

  if (recalled.baseline) {
    await atomicWrite(
      path.join(root, '.noosphere', 'baseline.md'),
      recalled.baseline,
    );
    console.log('  baseline.md restored from Walrus');
    restored++;
  } else {
    console.log('  baseline.md kept local; no Walrus baseline found');
  }

  if (recalled.masterPrompt) {
    await atomicWrite(
      path.join(root, '.noosphere', 'master-prompt.md'),
      recalled.masterPrompt,
    );
    console.log('  master-prompt.md restored from Walrus');
    restored++;
  }

  if (recalled.followups.length > 0) {
    const lines = recalled.followups.map((f) => JSON.stringify(f)).join('\n');
    await atomicWrite(
      path.join(root, '.noosphere', 'followups.jsonl'),
      `${lines}\n`,
    );
    console.log(`  followups.jsonl restored (${recalled.followups.length} entries) from Walrus`);
    restored++;
  }

  await refreshContext(root);
  console.log(`  context.md refreshed from Walrus`);
  console.log(`Restore complete. ${restored} file(s) written.`);
}

async function capturePromptFromCli(root) {
  const content = await readExactCliContent();
  const result = await captureMasterPrompt(root, content, {
    share: !process.argv.includes('--local-only'),
    source: readFlag('--source') || 'agent-hook',
    agentId:
      readFlag('--agent') ||
      process.env.NOOSPHERE_AGENT_ID ||
      'agent-hook',
  });
  printMasterPromptResult(result);
}

export async function captureMasterPrompt(
  root,
  content,
  {
    force = false,
    automatic = true,
    share = true,
    source = 'unknown',
    agentId = 'project-owner',
  } = {},
) {
  const prompt = String(content || '');
  if (!prompt.trim()) {
    return { captured: false, reason: 'empty' };
  }
  const config = await loadConfig(root);
  if (automatic && config.privacy.capture_master_prompt === false) {
    return { captured: false, reason: 'disabled' };
  }
  const existing = await readMasterPrompt(root);
  if (existing && !force) {
    return captureFollowupPrompt(root, prompt, {
      config,
      share,
      source,
      agentId,
    });
  }
  if (automatic && !force && !isMasterPromptCandidate(prompt)) {
    return { captured: false, reason: 'not-master-prompt' };
  }
  if (existing === prompt) {
    return { captured: false, reason: 'unchanged', hash: hash(prompt) };
  }

  await atomicWrite(
    path.join(root, '.noosphere', 'master-prompt.md'),
    prompt,
  );
  if (!share) {
    return {
      captured: true,
      kind: 'master',
      hash: hash(prompt),
      localOnly: true,
    };
  }
  const response = await storeCliMemory(config, {
    content: prompt,
    actionType: 'master-prompt',
    agentId,
    client: source,
  });
  return {
    captured: true,
    kind: 'master',
    hash: hash(prompt),
    pending: response.pending === true,
    response,
  };
}

async function shareMasterPromptFromCli(root) {
  const config = await loadConfig(root);
  const content = await readMasterPrompt(root);
  if (!content) {
    throw new Error('No master prompt has been captured for this project.');
  }
  const response = await storeCliMemory(config, {
    content,
    actionType: 'master-prompt',
    agentId:
      readFlag('--agent') ||
      process.env.NOOSPHERE_AGENT_ID ||
      'agent-hook',
    client: readFlag('--source') || 'agent-hook',
  });
  process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
}

async function shareFollowupPromptFromCli(root) {
  const config = await loadConfig(root);
  const requestedHash = readFlag('--hash');
  const followups = await readFollowupPrompts(root);
  const followup = requestedHash
    ? followups.find((entry) => entry.hash === requestedHash)
    : followups.at(-1);
  if (!followup) {
    throw new Error('No matching follow-up prompt has been captured.');
  }
  const response = await storeCliMemory(config, {
    content: followup.content,
    actionType: 'user-followup',
    agentId:
      readFlag('--agent') ||
      followup.agent_id ||
      process.env.NOOSPHERE_AGENT_ID ||
      'agent-hook',
    client: readFlag('--source') || followup.source || 'agent-hook',
  });
  process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
}

async function captureFollowupPrompt(
  root,
  prompt,
  { config, share, source, agentId },
) {
  const record = {
    timestamp: new Date().toISOString(),
    source,
    agent_id: agentId,
    hash: hash(prompt),
    content: prompt,
  };
  await appendFile(
    path.join(root, '.noosphere', 'followups.jsonl'),
    `${JSON.stringify(record)}\n`,
    'utf8',
  );
  if (!share) {
    return {
      captured: true,
      kind: 'followup',
      hash: record.hash,
      localOnly: true,
    };
  }
  const response = await storeCliMemory(config, {
    content: prompt,
    actionType: 'user-followup',
    agentId,
    client: source,
  });
  return {
    captured: true,
    kind: 'followup',
    hash: record.hash,
    pending: response.pending === true,
    response,
  };
}

export function isMasterPromptCandidate(content) {
  const text = String(content || '').trim();
  if (text.length < 200) return false;

  const phases = new Set(
    [...text.matchAll(/\bphase\s+([a-z0-9]+)\b/gi)].map((match) =>
      match[1].toLowerCase(),
    ),
  );
  if (phases.size >= 2) return true;

  const structuredLines = text
    .split(/\r?\n/)
    .filter((line) =>
      /^(?:#{1,6}\s+|\s*(?:\d+[.)]|[-*])\s+\S)/.test(line),
    ).length;
  return text.length >= 1_000 && structuredLines >= 3;
}

async function ollamaFromCli(root) {
  const config = await loadConfig(root);
  const options = parseOllamaArguments(process.argv.slice(3));
  const instructions = await readFile(
    path.join(root, '.noosphere', 'instructions.md'),
    'utf8',
  ).catch(() => '');
  let context;
  try {
    context = await refreshContext(root, {
      query:
        options.prompt ||
        'latest project changes decisions blockers tests and next steps',
    });
  } catch (error) {
    console.warn(
      `[Noosphere] Remote context refresh failed; using local context: ${error.message}`,
    );
    context = await readFile(
      path.join(root, '.noosphere', 'context.md'),
      'utf8',
    ).catch(() => emptyContext(config.project_id));
  }
  const journal = await readFile(
    path.join(root, '.noosphere', 'journal.md'),
    'utf8',
  ).catch(() => '');
  const masterPrompt = await readMasterPrompt(root);
  const followups = formatFollowupPrompts(await readFollowupPrompts(root));

  await runOllamaSession({
    projectId: config.project_id,
    model: options.model,
    prompt: options.prompt,
    host: options.host,
    instructions,
    context,
    journal,
    masterPrompt,
    followups,
    shouldStore: options.shouldStore,
    capturePrompt: (prompt) =>
      captureMasterPrompt(root, prompt, {
        source: 'noosphere-ollama',
        agentId: options.agentId,
      }),
    storeHandoff: async (summary) => {
      const entry = [
        `## ${new Date().toISOString()} - ollama:${options.model} / session`,
        '',
        summary,
        '',
      ].join('\n');
      await appendFile(
        path.join(root, '.noosphere', 'journal.md'),
        entry,
        'utf8',
      );
      return storeCliMemory(config, {
        content: summary,
        actionType: 'session',
        agentId: options.agentId,
        client: 'noosphere-ollama',
        provider: 'Ollama',
        model: options.model,
      });
    },
  });
}

async function printProtocol(root) {
  const file = path.join(root, '.noosphere', 'instructions.md');
  process.stdout.write(await readFile(file, 'utf8'));
}

async function readMasterPrompt(root) {
  return readFile(
    path.join(root, '.noosphere', 'master-prompt.md'),
    'utf8',
  ).catch(() => '');
}

async function readFollowupPrompts(root) {
  const content = await readFile(
    path.join(root, '.noosphere', 'followups.jsonl'),
    'utf8',
  ).catch(() => '');
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const entry = JSON.parse(line);
        return typeof entry.content === 'string' ? [entry] : [];
      } catch {
        return [];
      }
    });
}

function formatFollowupPrompts(followups) {
  return followups
    .map(
      (entry, index) =>
        `### Follow-up ${index + 1} — ${entry.timestamp || 'time unknown'}\n\n` +
        `${entry.content}`,
    )
    .join('\n\n');
}

function printMasterPromptResult(result) {
  if (result.captured) {
    const disposition = result.localOnly
      ? 'saved locally'
      : result.pending
        ? 'queued'
        : 'stored';
    const label =
      result.kind === 'followup' ? 'Follow-up prompt' : 'Master prompt';
    console.log(
      `${label} captured exactly and ${disposition}. ` +
        `Hash: ${result.hash}`,
    );
    return;
  }
  const messages = {
    empty: 'Master prompt was empty.',
    'not-master-prompt':
      'Prompt was not promoted: it was not a substantial structured or multi-phase instruction.',
    unchanged: 'Master prompt is unchanged.',
    disabled:
      'Automatic master-prompt capture is disabled in .noosphere/config.json.',
  };
  console.log(messages[result.reason] || 'Master prompt was not changed.');
}

async function storeCliMemory(
  config,
  {
    content,
    actionType,
    agentId,
    client,
    provider = process.env.NOOSPHERE_PROVIDER || null,
    model = process.env.NOOSPHERE_MODEL || null,
  },
) {
  return requestJson(`${config.relayer_url}/v1/actions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `cli-${randomUUID()}`,
    },
    body: JSON.stringify({
      project_id: config.project_id,
      agent_id: agentId,
      action_type: actionType,
      content,
      session_id: process.env.NOOSPHERE_SESSION_ID || `cli-${Date.now()}`,
      provider,
      model,
      client,
    }),
  });
}

async function readCliContent() {
  const flagValue = readFlag('--content');
  if (flagValue) return flagValue;
  const positional = process.argv
    .slice(3)
    .filter((value, index, values) => {
      const previous = values[index - 1];
      return (
        !value.startsWith('--') &&
        ![
          '--agent',
          '--type',
          '--client',
          '--query',
          '--content',
        ].includes(previous)
      );
    })
    .join(' ')
    .trim();
  if (positional) return positional;
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const piped = Buffer.concat(chunks).toString('utf8').trim();
    if (piped) return piped;
  }
  throw new Error('Provide content as arguments, --content, or stdin.');
}

async function readExactCliContent() {
  const flagValue = readFlag('--content');
  if (flagValue) return flagValue;
  const positional = contentPositionals().join(' ');
  if (positional) return positional;
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const piped = Buffer.concat(chunks).toString('utf8');
    if (piped.trim()) return piped;
  }
  throw new Error('Provide content as arguments, --content, or stdin.');
}

function contentPositionals() {
  const valueFlags = new Set([
    '--agent',
    '--type',
    '--client',
    '--query',
    '--content',
    '--source',
    '--path',
    '--commits',
  ]);
  return process.argv
    .slice(3)
    .filter((value, index, values) => {
      const previous = values[index - 1];
      return !value.startsWith('--') && !valueFlags.has(previous);
    });
}

function readFlag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function normalizeRefreshMs(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(parsed, DEFAULT_REFRESH_MS)
    : DEFAULT_REFRESH_MS;
}

function normalizeBaselineHistoryLimit(value) {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_BASELINE_HISTORY_COMMITS;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error('--commits must be a positive integer.');
  }
  return Math.min(parsed, MAX_BASELINE_HISTORY_COMMITS);
}

async function writeUniversalProtocol(root, projectId) {
  const slug = sanitizeProjectId(projectId);
  const content = `# Noosphere universal agent protocol

This protocol is vendor-neutral. It works through files, commands, HTTP, or
MCP. An agent does not need a Noosphere-specific SDK.

## Start

1. Read \`.noosphere/baseline.md\` if it exists. It is a bounded,
   machine-generated snapshot of the repository state and selected Git
   history when Noosphere joined an established project.
2. Read \`.noosphere/master-prompt.md\` if it is non-empty. It contains the
   exact original project instruction and is pinned above later summaries.
3. Read \`.noosphere/followups.jsonl\` in order. Later user instructions refine
   the master prompt without erasing it.
4. Read \`.noosphere/context.md\`.
5. Read \`.noosphere/journal.md\`.
6. Inspect the current working tree.

When the user asks to continue a later phase, recover that phase from the
master prompt instead of guessing from completed work.

## During work

After a material finding, decision, failed approach, or plan change, append a
concise entry to \`.noosphere/journal.md\`:

- conclusion;
- evidence or affected files;
- what was attempted;
- next step or verification needed.

Do not reveal or request hidden chain-of-thought. Store a brief public
rationale that another engineer can verify.

## Before stopping

Append a handoff entry with completed work, unresolved issues, tests, and the
next recommended action.

## Universal interfaces

- File context: \`.noosphere/context.md\`
- Initial project baseline: \`.noosphere/baseline.md\`
- Master prompt: \`.noosphere/master-prompt.md\`
- Ordered follow-ups: \`.noosphere/followups.jsonl\`
- Work journal: \`.noosphere/journal.md\`
- CLI context: \`noosphere context\`
- CLI recall: \`noosphere recall "query"\`
- CLI remember: \`printf '%s' "note" | noosphere remember --agent my-agent\`
- CLI journal: \`noosphere journal --agent my-agent "finding"\`
- CLI master prompt: \`noosphere master-prompt\`
- HTTP bootstrap: \`GET /v1/projects/${slug}/bootstrap\`
- HTTP remember: \`POST /v1/actions\`
- HTTP recall: \`POST /v1/projects/${slug}/recall\`
- MCP namespace: \`noosphere-${slug}\`
`;
  await writeFile(
    path.join(root, '.noosphere', 'instructions.md'),
    content,
    'utf8',
  );
  await writeJson(path.join(root, '.noosphere', 'protocol.json'), {
    protocol: 'noosphere-continuity',
    version: '1.0',
    project_id: projectId,
    namespace: `noosphere-${slug}`,
    files: {
      baseline: '.noosphere/baseline.md',
      context: '.noosphere/context.md',
      journal: '.noosphere/journal.md',
      master_prompt: '.noosphere/master-prompt.md',
      followups: '.noosphere/followups.jsonl',
      instructions: '.noosphere/instructions.md',
    },
    interfaces: ['filesystem', 'cli', 'http', 'mcp'],
  });
}

async function readProjectConfig(root) {
  return (
    (await readJson(path.join(root, '.noosphere', 'config.json'))) ||
    (await readJson(path.join(root, '.noosphere.json')))
  );
}

async function writeProjectConfig(root, config) {
  await mkdir(path.join(root, '.noosphere'), { recursive: true });
  await writeJson(path.join(root, '.noosphere', 'config.json'), config);
  await rm(path.join(root, '.noosphere.json'), { force: true });
}

async function projectConfigExists(root) {
  return Boolean(await readProjectConfig(root));
}

async function removeLegacyProjectFiles(root) {
  const legacyProtocol = path.join(root, 'NOOSPHERE.md');
  const content = await readFile(legacyProtocol, 'utf8').catch(() => '');
  if (content.startsWith('# Noosphere universal agent protocol')) {
    await rm(legacyProtocol, { force: true });
  }

  const gitignore = path.join(root, '.gitignore');
  const current = await readFile(gitignore, 'utf8').catch(() => null);
  if (current === null) return;
  const legacyEntries = new Set([
    '.noosphere/context.md',
    '.noosphere/journal.md',
    '.noosphere/state.json',
    '.noosphere/*.tmp',
  ]);
  const remaining = current
    .split(/\r?\n/)
    .filter((line) => !legacyEntries.has(line))
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
  if (remaining) {
    await writeFile(gitignore, `${remaining}\n`, 'utf8');
  } else {
    await rm(gitignore, { force: true });
  }
}

async function formatLocalJournal(root) {
  const journal = await readFile(
    path.join(root, '.noosphere', 'journal.md'),
    'utf8',
  ).catch(() => '');
  const firstEntry = journal.indexOf('\n## ');
  const entries =
    firstEntry >= 0 ? journal.slice(firstEntry + 1).trim() : '';
  return entries
    ? `## Local public work journal\n\n${entries}\n`
    : '## Local public work journal\n\nNo entries yet.\n';
}

async function fileHasJournalEntries(root) {
  const journal = await readFile(
    path.join(root, '.noosphere', 'journal.md'),
    'utf8',
  ).catch(() => '');
  return journal.includes('\n## ');
}

async function git(root, args) {
  const { stdout } = await execFileAsync('git', args, {
    cwd: root,
    maxBuffer: 2_000_000,
  });
  return stdout.trimEnd();
}

async function assertGitRepository(root) {
  const inside = await git(root, ['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') throw new Error('Current directory is not a Git repository.');
}

async function findGitRoot(start) {
  try {
    return await git(path.resolve(start), [
      'rev-parse',
      '--show-toplevel',
    ]);
  } catch {
    return null;
  }
}

async function pingRelayer(url) {
  try {
    const response = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function relayerDownError(url) {
  return new Error(
    [
      `Cannot reach the Noosphere relayer at ${url}.`,
      '',
      'Start it for your platform:',
      '  macOS:   launchctl kickstart -k gui/$UID/xyz.noosphere.relayer',
      '  Linux:   systemctl --user start xyz.noosphere.relayer',
      '  Windows: schtasks /Run /TN "\\Noosphere\\Relayer"',
      '',
      'If the relayer listens on a different host or port, set',
      'NOOSPHERE_RELAYER_URL or relayer_url in .noosphere/config.json.',
      '',
      'To try Noosphere without Walrus credentials, run:',
      '  noosphere setup --demo',
    ].join('\n'),
  );
}

async function requestJson(url, options) {
  const response = await fetch(url, {
    ...options,
    headers: withAuthentication(options?.headers),
    signal: AbortSignal.timeout(
      Number(process.env.NOOSPHERE_WRITE_TIMEOUT_MS) ||
        DEFAULT_WRITE_TIMEOUT_MS,
    ),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error || `${response.status} ${response.statusText}`);
  }
  return body;
}

async function requestText(url) {
  const response = await fetch(url, {
    headers: withAuthentication({ accept: 'text/plain' }),
    signal: AbortSignal.timeout(
      Number(process.env.NOOSPHERE_READ_TIMEOUT_MS) ||
        DEFAULT_READ_TIMEOUT_MS,
    ),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `${response.status} ${response.statusText}`);
  }
  return text;
}

function withAuthentication(headers = {}) {
  const token = process.env.NOOSPHERE_API_TOKEN;
  if (!token) return headers;
  return {
    ...headers,
    authorization: `Bearer ${token}`,
  };
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeTextIfMissing(file, value) {
  try {
    await access(file);
  } catch {
    await writeFile(file, value, 'utf8');
  }
}

async function atomicWrite(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, 'utf8');
  await rename(temporary, file);
}

function emptyContext(projectId) {
  return `# Noosphere shared context

Project: ${projectId}

No shared memory has been loaded yet. Start the continuity watcher.
`;
}

function journalTemplate(projectId) {
  return `# Noosphere public work journal

Project: ${projectId}

Write concise, externally understandable findings and handoffs here. Do not
write hidden chain-of-thought, secrets, credentials, or private internal
reasoning.

`;
}

function sanitizeProjectId(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'project';
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function logBackgroundError(error) {
  console.warn(`Noosphere continuity: ${error.message}`);
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function parseAdapters(value) {
  if (!value) {
    throw new Error(
      `Choose adapters with --only. Options: ${ALL_ADAPTERS.join(', ')}, all, none.`,
    );
  }
  const requested = value
    .split(',')
    .map((adapter) => adapter.trim().toLowerCase())
    .filter(Boolean);
  if (requested.includes('all')) return [...ALL_ADAPTERS];
  if (requested.includes('none')) return [];
  const unknown = requested.filter(
    (adapter) => !ALL_ADAPTERS.includes(adapter),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Unknown adapter(s): ${unknown.join(', ')}. ` +
      `Options: ${ALL_ADAPTERS.join(', ')}.`,
    );
  }
  return [...new Set(requested)];
}

function parseOllamaArguments(args) {
  const values = [...args];
  if (values[0] === 'run') values.shift();
  const options = {
    host: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
    shouldStore: true,
  };
  const positional = [];

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--no-store') {
      options.shouldStore = false;
      continue;
    }
    if (['--host', '--agent', '--prompt'].includes(value)) {
      const next = values[index + 1];
      if (!next) throw new Error(`${value} requires a value.`);
      if (value === '--host') options.host = next;
      if (value === '--agent') options.agentId = next;
      if (value === '--prompt') options.prompt = next;
      index += 1;
      continue;
    }
    if (value.startsWith('--')) {
      throw new Error(`Unknown Ollama option: ${value}`);
    }
    positional.push(value);
  }

  options.model = positional.shift();
  if (!options.model) {
    throw new Error(
      'Usage: noosphere ollama <model> [prompt] [--host URL] [--no-store]',
    );
  }
  options.prompt = options.prompt || positional.join(' ');
  options.agentId = options.agentId || `ollama:${options.model}`;
  return options;
}

function printHelp() {
  console.log(`Noosphere continuity

Commands:
  install     Install Noosphere and automatic user startup
  uninstall   Remove the user installation and background services
  doctor      Check the installed lifecycle and credentials
  setup       First-time setup wizard (add --demo for local-only mode)
  credentials Inspect, migrate, or rotate Walrus Memory credentials
  run-relayer Run the relayer in the foreground (when background services
              are blocked by AV/UAC)
  run-manager Run the project manager in the foreground
  activate    Auto-initialize and register the current Git project
  deactivate  Stop automatically watching the current project
  register    Register a project now (supports --path /absolute/repository)
  adapters    Keep only selected adapters (example: adapters --only claude)
  projects    List registered projects
  init        Add project config and agent instructions
  watch       Checkpoint settled working-tree changes and refresh context
  checkpoint  Store the current workspace state now
  baseline    Create one established-project baseline from current Git history
  refresh     Refresh .noosphere/context.md now
  status      Show continuity status
  context     Print the current shared context
  recall      Recall project memory by semantic query
  remember    Store a memory from arguments or stdin
  journal     Append a concise public work note
  master-prompt
              Print or explicitly store the exact pinned project prompt
  ollama      Run any Ollama model with shared project memory
  protocol    Print the universal agent protocol
  state       Print the ACP continuity kernel (--json for the envelope,
              validate to verify the persisted state)
  handoff     Merge a structured ACP handoff (--file <path> or --stdin)

Ollama examples:
  noosphere ollama qwen3-coder
  noosphere ollama run minimax-m2 "Continue phase 2"
  noosphere ollama llama3.2 --no-store

Master prompt examples:
  cat plan.md | noosphere master-prompt
  noosphere master-prompt --replace --content "Updated project plan..."

Project baseline examples:
  noosphere baseline
  noosphere baseline --commits 100 --force
`);
}
