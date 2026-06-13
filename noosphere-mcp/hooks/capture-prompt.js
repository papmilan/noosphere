#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const input = await readHookInput();
const prompt = typeof input.prompt === 'string' ? input.prompt : '';
if (!prompt) process.exit(0);

const startDirectory = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const projectRoot = findGitRoot(startDirectory);
if (!projectRoot) process.exit(0);

const configFile = path.join(projectRoot, '.noosphere', 'config.json');
try {
  readFileSync(configFile);
} catch {
  process.exit(0);
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const continuityCli = path.resolve(scriptDirectory, '..', 'continuity', 'index.js');
const agentId = input.model ? `codex:${input.model}` : 'agent-prompt-hook';
const source =
  input.model || input.turn_id
    ? 'codex-user-prompt'
    : 'claude-code-user-prompt';

let captureOutput = '';
try {
  captureOutput = execFileSync(
    process.execPath,
    [
      continuityCli,
      'capture-prompt',
      '--path',
      projectRoot,
      '--local-only',
      '--source',
      source,
      '--agent',
      agentId,
    ],
    {
      input: prompt,
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
    },
  );
} catch {
  // Prompt capture must never prevent the host agent from continuing.
}

const capture = parseCaptureOutput(captureOutput);
if (capture) {
  const shareCommand =
    capture.kind === 'followup'
      ? 'share-followup-prompt'
      : 'share-master-prompt';
  const shareArgs = [
    continuityCli,
    shareCommand,
    '--path',
    projectRoot,
    '--source',
    source,
    '--agent',
    agentId,
  ];
  if (capture.kind === 'followup') {
    shareArgs.push('--hash', capture.hash);
  }
  const child = spawn(
    process.execPath,
    shareArgs,
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  child.unref();
}

const intent = readProjectIntent(projectRoot);
if (intent) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: [
          'NOOSPHERE PINNED MASTER PROMPT',
          'Treat this as the original project intent. Preserve unfinished phases and constraints.',
          '',
          intent,
        ].join('\n'),
      },
    }),
  );
}

async function readHookInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

function findGitRoot(start) {
  try {
    return execFileSync('git', ['-C', start, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      timeout: 2_000,
      windowsHide: true,
    }).trim();
  } catch {
    return '';
  }
}

function readProjectIntent(root) {
  let masterPrompt = '';
  try {
    masterPrompt = readFileSync(
      path.join(root, '.noosphere', 'master-prompt.md'),
      'utf8',
    );
  } catch {
    // A project may not have a master prompt yet.
  }
  const followups = readFollowups(root);
  if (!masterPrompt && followups.length === 0) return '';
  return [
    'ORIGINAL MASTER PROMPT',
    masterPrompt || '[Not captured]',
    '',
    'FOLLOW-UP USER INSTRUCTIONS (oldest to newest)',
    followups.length > 0
      ? followups
          .map(
            (entry, index) =>
              `Follow-up ${index + 1} (${entry.timestamp || 'time unknown'}):\n` +
              entry.content,
          )
          .join('\n\n')
      : '[None]',
  ].join('\n');
}

function readFollowups(root) {
  let content = '';
  try {
    content = readFileSync(
      path.join(root, '.noosphere', 'followups.jsonl'),
      'utf8',
    );
  } catch {
    return [];
  }
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

function parseCaptureOutput(output) {
  const match = String(output).match(
    /(Master|Follow-up) prompt captured exactly.*Hash: ([a-f0-9]{64})/i,
  );
  if (!match) return null;
  return {
    kind: match[1].toLowerCase() === 'follow-up' ? 'followup' : 'master',
    hash: match[2],
  };
}
