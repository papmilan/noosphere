#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const claudeDir =
  process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const hookDir = path.join(claudeDir, 'hooks', 'noosphere');
const sessionHookPath = path.join(hookDir, 'post-session.js');
const promptHookPath = path.join(hookDir, 'capture-prompt.js');
const settingsPath = path.join(claudeDir, 'settings.json');

const sessionCommand = `"${process.execPath}" "${sessionHookPath}"`;
const promptCommand = `"${process.execPath}" "${promptHookPath}"`;
const legacySessionCommand = `bash "${path.join(hookDir, 'post-session.sh')}"`;

const sessionEntry = {
  type: 'command',
  command: sessionCommand,
  timeout: 145,
  statusMessage: 'Storing session in Noosphere...',
};
const promptEntry = {
  type: 'command',
  command: promptCommand,
  timeout: 15,
  statusMessage: 'Checking project intent...',
};

async function main() {
  await mkdir(hookDir, { recursive: true, mode: 0o700 });
  await copyFile(path.join(here, 'post-session.js'), sessionHookPath);
  await copyFile(path.join(here, 'capture-prompt.js'), promptHookPath);
  await chmod(sessionHookPath, 0o700);
  await chmod(promptHookPath, 0o700);

  let settings = {};
  if (existsSync(settingsPath)) {
    const raw = await readFile(settingsPath, 'utf8').catch(() => '');
    try {
      settings = raw.trim() ? JSON.parse(raw) : {};
    } catch (error) {
      throw new Error(
        `Failed to parse ${settingsPath}: ${error.message}. ` +
        'Fix or remove that file and re-run install:user.',
      );
    }
  }

  const backupPath = `${settingsPath}.noosphere-backup-${timestamp()}`;
  if (existsSync(settingsPath)) {
    await copyFile(settingsPath, backupPath);
  }

  settings.hooks = settings.hooks || {};
  settings.hooks.UserPromptSubmit = upsertHookList(
    settings.hooks.UserPromptSubmit,
    promptCommand,
    promptEntry,
  );
  settings.hooks.SessionEnd = upsertHookList(
    settings.hooks.SessionEnd,
    sessionCommand,
    sessionEntry,
    [legacySessionCommand],
  );

  const temporaryPath = `${settingsPath}.${randomUUID()}.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify(settings, null, 2)}\n`,
    { mode: 0o600 },
  );
  await rename(temporaryPath, settingsPath);
  await chmod(settingsPath, 0o600);

  process.stdout.write(`Installed Noosphere hook: ${sessionHookPath}\n`);
  process.stdout.write(`Installed Noosphere prompt capture: ${promptHookPath}\n`);
  process.stdout.write(
    `Registered Claude Code SessionEnd hook in: ${settingsPath}\n`,
  );
  if (existsSync(backupPath)) {
    process.stdout.write(`Backup created: ${backupPath}\n`);
  }
  process.stdout.write(
    'Run noosphere activate inside each project you want to track.\n',
  );
}

function upsertHookList(existing, command, entry, retiredCommands = []) {
  const list = Array.isArray(existing) ? existing : [];
  const retired = new Set(retiredCommands);

  for (const group of list) {
    const hooks = Array.isArray(group?.hooks) ? group.hooks : [];
    for (const hook of hooks) {
      if (hook?.command === command || retired.has(hook?.command)) {
        hook.type = entry.type;
        hook.command = entry.command;
        hook.timeout = entry.timeout;
        hook.statusMessage = entry.statusMessage;
        return list;
      }
    }
  }

  list.push({ hooks: [{ ...entry }] });
  return list;
}

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
