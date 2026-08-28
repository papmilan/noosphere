#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const claudeDir =
  process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const hookDir = path.join(claudeDir, 'hooks', 'noosphere');
const sessionHookPath = path.join(hookDir, 'post-session.js');
const promptHookPath = path.join(hookDir, 'capture-prompt.js');
const settingsPath = path.join(claudeDir, 'settings.json');

const sessionCommand = `"${process.execPath}" "${sessionHookPath}"`;
const promptCommand = `"${process.execPath}" "${promptHookPath}"`;
// Both events shipped a bash launcher before the Node one. Reinstalling has to
// retire each of them, or the retired script keeps running beside its
// replacement: the legacy prompt hook captures the prompt a second time and
// injects the pinned master prompt into context twice on every turn.
const legacySessionCommand = `bash "${path.join(hookDir, 'post-session.sh')}"`;
const legacyPromptCommand = `bash "${path.join(hookDir, 'capture-prompt.sh')}"`;

// One matcher shape for both events. Keeping these as separate literals is what
// let SessionEnd retire its bash launcher while UserPromptSubmit did not.
function managedCommand(current, legacy, scriptPath) {
  return (candidate) => candidate === current
    || candidate === legacy
    || candidate.includes(`"${scriptPath}"`);
}

const sessionEntry = {
  type: 'command',
  command: sessionCommand,
  timeout: 60,
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
  await writeHookLauncher(sessionHookPath, path.join(here, 'post-session.js'));
  await writeHookLauncher(promptHookPath, path.join(here, 'capture-prompt.js'));
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

  if (settings === null || Array.isArray(settings) || typeof settings !== 'object') {
    throw new Error('Claude settings must contain a JSON object.');
  }
  if (settings.hooks !== undefined && (
    settings.hooks === null ||
    Array.isArray(settings.hooks) ||
    typeof settings.hooks !== 'object'
  )) {
    throw new Error('settings.hooks must be an object; the existing settings file was not changed.');
  }

  const backupPath = `${settingsPath}.noosphere-backup-${timestamp()}`;
  if (existsSync(settingsPath)) {
    await copyFile(settingsPath, backupPath);
  }

  settings.hooks ||= {};
  settings.hooks.UserPromptSubmit = upsertHookList(
    settings.hooks.UserPromptSubmit,
    promptEntry,
    managedCommand(promptCommand, legacyPromptCommand, promptHookPath),
  );
  settings.hooks.SessionEnd = upsertHookList(
    settings.hooks.SessionEnd,
    sessionEntry,
    managedCommand(sessionCommand, legacySessionCommand, sessionHookPath),
  );

  const temporaryPath = `${settingsPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(settings, null, 2)}\n`,
      { mode: 0o600 },
    );
    await rename(temporaryPath, settingsPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
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

async function writeHookLauncher(destination, source) {
  await writeFile(
    destination,
    `#!/usr/bin/env node\nimport ${JSON.stringify(pathToFileURL(source).href)};\n`,
    { mode: 0o700 },
  );
}

// A group carrying a matcher only runs for that matcher; a group without one
// runs for every occurrence of the event.
function unscopedGroup(group) {
  return typeof group.matcher !== 'string' || group.matcher === '';
}

function upsertHookList(existing, entry, isManagedCommand) {
  if (existing !== undefined && !Array.isArray(existing)) {
    throw new Error('a Claude hook event must be an array; the existing settings file was not changed.');
  }
  const list = existing || [];
  const managed = [];
  for (let index = 0; index < list.length; index += 1) {
    const group = list[index];
    if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) continue;
    if (group.hooks.some((hook) => isManagedCommand(typeof hook?.command === 'string' ? hook.command : ''))) {
      managed.push(index);
    }
  }
  // Collapsing duplicates must not narrow when the hook runs. Keeping whichever
  // copy came first would let a matcher-scoped duplicate delete the copy that
  // runs on every event, silently reducing Noosphere to that one matcher. Prefer
  // an unscoped group; a scoped one is only kept when it is the sole placement
  // the owner configured, which is theirs to decide rather than ours to move.
  const keepIndex = managed.find((index) => unscopedGroup(list[index])) ?? managed[0];
  const updated = [];
  let installed = false;

  for (let index = 0; index < list.length; index += 1) {
    const group = list[index];
    if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) {
      updated.push(group);
      continue;
    }
    const hooks = [];
    for (const hook of group.hooks) {
      const command = typeof hook?.command === 'string' ? hook.command : '';
      if (!isManagedCommand(command)) {
        hooks.push(hook);
        continue;
      }
      if (index === keepIndex && !installed) {
        hooks.push({ ...hook, ...entry });
        installed = true;
      }
    }
    if (hooks.length > 0) updated.push({ ...group, hooks });
  }

  if (!installed) updated.push({ hooks: [{ ...entry }] });

  return updated;
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
