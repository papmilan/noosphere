#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  access,
  appendFile,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_RELAYER_URL = 'http://127.0.0.1:3001';
const DEFAULT_DEBOUNCE_MS = 8_000;
const DEFAULT_REFRESH_MS = 20_000;
const MANAGED_START = '<!-- noosphere:continuity:start -->';
const MANAGED_END = '<!-- noosphere:continuity:end -->';

const command = process.argv[2] || 'help';
const projectDir = path.resolve(
  process.env.NOOSPHERE_PROJECT_DIR ||
    process.env.INIT_CWD ||
    '.',
);

try {
  switch (command) {
    case 'init':
      await initializeProject(projectDir);
      break;
    case 'watch':
      await watchProject(projectDir);
      break;
    case 'checkpoint':
      await checkpointProject(projectDir, { force: true });
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
    case 'protocol':
      await printProtocol(projectDir);
      break;
    default:
      printHelp();
  }
} catch (error) {
  console.error(`Noosphere continuity: ${error.message}`);
  process.exitCode = 1;
}

export async function initializeProject(root) {
  await assertGitRepository(root);
  const configPath = path.join(root, '.noosphere.json');
  const existing = await readJson(configPath);
  const projectId =
    existing?.project_id || sanitizeProjectId(path.basename(root));
  const config = {
    project_id: projectId,
    relayer_url: existing?.relayer_url || DEFAULT_RELAYER_URL,
    checkpoint_debounce_ms:
      existing?.checkpoint_debounce_ms || DEFAULT_DEBOUNCE_MS,
    context_refresh_ms:
      existing?.context_refresh_ms || DEFAULT_REFRESH_MS,
    privacy: {
      checkpoint_content:
        existing?.privacy?.checkpoint_content || 'metadata-only',
      include_diff: existing?.privacy?.include_diff === true,
      share_journal: existing?.privacy?.share_journal === true,
    },
  };

  await writeJson(configPath, config);
  await mkdir(path.join(root, '.noosphere'), { recursive: true });
  await writeTextIfMissing(
    path.join(root, '.noosphere', 'context.md'),
    emptyContext(projectId),
  );
  await writeTextIfMissing(
    path.join(root, '.noosphere', 'journal.md'),
    journalTemplate(projectId),
  );
  await writeAgentAdapters(root, projectId);
  await writeUniversalProtocol(root, projectId);
  await writeMcpConfigs(root, projectId);
  await ensureGitignore(root);

  console.log(`Noosphere continuity initialized for ${projectId}.`);
  console.log('Run: npm --prefix noosphere-mcp run continuity:watch');
}

export async function watchProject(root, options = {}) {
  await assertGitRepository(root);
  const config = await loadConfig(root);
  const debounceMs =
    options.debounceMs || config.checkpoint_debounce_ms;
  const refreshMs =
    options.refreshMs || config.context_refresh_ms;
  let lastFingerprint = await workspaceFingerprint(root);
  let pendingSince = null;
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
      }
      if (
        pendingSince &&
        Date.now() - pendingSince >= debounceMs &&
        !checkpointRunning
      ) {
        checkpointRunning = true;
        pendingSince = null;
        try {
          await checkpointProject(root);
        } catch (error) {
          pendingSince = Date.now();
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

export async function checkpointProject(root, { force = false } = {}) {
  const config = await loadConfig(root);
  const snapshot = await buildWorkspaceSnapshot(root, config);
  const statePath = path.join(root, '.noosphere', 'state.json');
  const state = (await readJson(statePath)) || {};
  const fingerprint = hash(JSON.stringify(snapshot));

  if (!force && state.last_checkpoint_fingerprint === fingerprint) {
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
    last_checkpoint_fingerprint: fingerprint,
    last_checkpoint_at: new Date().toISOString(),
    last_blob_id: response.blob_id,
  });
  console.log(
    `Noosphere checkpoint stored: ${snapshot.changed_files.length} changed files.`,
  );
  return response;
}

export async function refreshContext(root) {
  const config = await loadConfig(root);
  const query = encodeURIComponent(
    'latest project changes failures decisions blockers tests and next steps',
  );
  const context = await requestText(
    `${config.relayer_url}/v1/projects/${encodeURIComponent(
      config.project_id,
    )}/context?format=text&limit=50&q=${query}`,
  );
  const output = [
    '# Noosphere shared context',
    '',
    `Project: ${config.project_id}`,
    `Refreshed: ${new Date().toISOString()}`,
    '',
    'Read this before changing the project. It may contain work from another AI tool.',
    '',
    '```text',
    context.trim(),
    '```',
    '',
    await formatLocalJournal(root),
  ].join('\n');
  await atomicWrite(path.join(root, '.noosphere', 'context.md'), output);
  return output;
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
        last_checkpoint_at: state?.last_checkpoint_at || null,
        last_blob_id: state?.last_blob_id || null,
      },
      null,
      2,
    ),
  );
}

async function writeMcpConfigs(root, projectId) {
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
  await writeJson(path.join(root, '.mcp.json'), {
    mcpServers: { noosphere: server },
  });
  await mkdir(path.join(root, '.cursor'), { recursive: true });
  await writeJson(path.join(root, '.cursor', 'mcp.json'), {
    mcpServers: { noosphere: server },
  });
}

async function writeAgentAdapters(root, projectId) {
  const shared = `${MANAGED_START}
## Noosphere continuity adapter

Noosphere's core protocol is vendor-neutral. This file is an auto-load adapter
for tools that recognize this filename.

1. Before working, read \`.noosphere/context.md\` and
   \`.noosphere/journal.md\`.
2. Inspect the working tree because another tool may have changed it.
3. Append concise findings, evidence, decisions, failed approaches, and
   handoffs to \`.noosphere/journal.md\`.
4. Do not record hidden chain-of-thought, secrets, or private internal
   reasoning.

Project namespace: \`noosphere-${sanitizeProjectId(projectId)}\`.
${MANAGED_END}`;
  await upsertManagedBlock(path.join(root, 'AGENTS.md'), shared);
  await upsertManagedBlock(path.join(root, 'CLAUDE.md'), shared);
  await upsertManagedBlock(path.join(root, 'GEMINI.md'), shared);

  await mkdir(path.join(root, '.cursor', 'rules'), { recursive: true });
  await writeFile(
    path.join(root, '.cursor', 'rules', 'noosphere.mdc'),
    `---
description: Load the universal Noosphere continuity protocol
alwaysApply: true
---

Read \`NOOSPHERE.md\`, \`.noosphere/context.md\`, and
\`.noosphere/journal.md\` before working. Append concise, verifiable findings
and handoffs to the journal. Do not write hidden chain-of-thought.
`,
    'utf8',
  );
}

async function ensureGitignore(root) {
  const gitignore = path.join(root, '.gitignore');
  let current = '';
  try {
    current = await readFile(gitignore, 'utf8');
  } catch {
    // A missing .gitignore is fine.
  }
  const entries = [
    '.noosphere/context.md',
    '.noosphere/journal.md',
    '.noosphere/state.json',
    '.noosphere/*.tmp',
  ];
  const missing = entries.filter(
    (entry) => !current.split(/\r?\n/).includes(entry),
  );
  if (missing.length > 0) {
    await appendFile(
      gitignore,
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

async function loadConfig(root) {
  const config = await readJson(path.join(root, '.noosphere.json'));
  if (!config?.project_id) {
    throw new Error('Run `node continuity/index.js init` in this project first.');
  }
  return {
    ...config,
    relayer_url: config.relayer_url || DEFAULT_RELAYER_URL,
    checkpoint_debounce_ms:
      config.checkpoint_debounce_ms || DEFAULT_DEBOUNCE_MS,
    context_refresh_ms:
      config.context_refresh_ms || DEFAULT_REFRESH_MS,
    privacy: {
      checkpoint_content:
        config.privacy?.checkpoint_content || 'metadata-only',
      include_diff: config.privacy?.include_diff === true,
      share_journal: config.privacy?.share_journal === true,
    },
  };
}

async function workspaceFingerprint(root) {
  const [status, diff, journal] = await Promise.all([
    git(root, ['status', '--porcelain=v1']),
    git(root, ['diff', '--no-ext-diff', '--binary', '--', '.']),
    readFile(path.join(root, '.noosphere', 'journal.md'), 'utf8').catch(
      () => '',
    ),
  ]);
  const lines = status
    .split('\n')
    .filter((line) => line && !line.includes('.noosphere/'));
  const untracked = lines
    .filter((line) => line.startsWith('?? '))
    .map((line) => line.slice(3));
  const untrackedState = [];

  for (const file of untracked.slice(0, 200)) {
    try {
      const details = await stat(path.join(root, file));
      untrackedState.push(
        `${file}:${details.size}:${details.mtimeMs}`,
      );
    } catch {
      untrackedState.push(`${file}:missing`);
    }
  }

  return hash(
    JSON.stringify({
      status: lines,
      diff,
      untracked: untrackedState,
      journal,
    }),
  );
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

async function printProtocol(root) {
  const file = path.join(root, 'NOOSPHERE.md');
  process.stdout.write(await readFile(file, 'utf8'));
}

async function storeCliMemory(
  config,
  { content, actionType, agentId, client },
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
      provider: process.env.NOOSPHERE_PROVIDER || null,
      model: process.env.NOOSPHERE_MODEL || null,
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

function readFlag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function writeUniversalProtocol(root, projectId) {
  const slug = sanitizeProjectId(projectId);
  const content = `# Noosphere universal agent protocol

This protocol is vendor-neutral. It works through files, commands, HTTP, or
MCP. An agent does not need a Noosphere-specific SDK.

## Start

1. Read \`.noosphere/context.md\`.
2. Read \`.noosphere/journal.md\`.
3. Inspect the current working tree.

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
- Work journal: \`.noosphere/journal.md\`
- CLI context: \`noosphere context\`
- CLI recall: \`noosphere recall "query"\`
- CLI remember: \`printf '%s' "note" | noosphere remember --agent my-agent\`
- CLI journal: \`noosphere journal --agent my-agent "finding"\`
- HTTP bootstrap: \`GET /v1/projects/${slug}/bootstrap\`
- HTTP remember: \`POST /v1/actions\`
- HTTP recall: \`POST /v1/projects/${slug}/recall\`
- MCP namespace: \`noosphere-${slug}\`
`;
  await writeFile(path.join(root, 'NOOSPHERE.md'), content, 'utf8');
  await writeJson(path.join(root, '.noosphere', 'protocol.json'), {
    protocol: 'noosphere-continuity',
    version: '1.0',
    project_id: projectId,
    namespace: `noosphere-${slug}`,
    files: {
      context: '.noosphere/context.md',
      journal: '.noosphere/journal.md',
      instructions: 'NOOSPHERE.md',
    },
    interfaces: ['filesystem', 'cli', 'http', 'mcp'],
  });
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
  return stdout.trim();
}

async function assertGitRepository(root) {
  const inside = await git(root, ['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') throw new Error('Current directory is not a Git repository.');
}

async function requestJson(url, options) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error || `${response.status} ${response.statusText}`);
  }
  return body;
}

async function requestText(url) {
  const response = await fetch(url, {
    headers: { accept: 'text/plain' },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `${response.status} ${response.statusText}`);
  }
  return text;
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
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

function printHelp() {
  console.log(`Noosphere continuity

Commands:
  init        Add project config and agent instructions
  watch       Checkpoint settled working-tree changes and refresh context
  checkpoint  Store the current workspace state now
  refresh     Refresh .noosphere/context.md now
  status      Show continuity status
  context     Print the current shared context
  recall      Recall project memory by semantic query
  remember    Store a memory from arguments or stdin
  journal     Append a concise public work note
  protocol    Print the universal agent protocol
`);
}
