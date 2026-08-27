import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const INSTALLER = fileURLToPath(new URL('../hooks/install-hook.js', import.meta.url));
const temporary = [];

after(async () => {
  await Promise.all(temporary.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function homeWithSettings(settings) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'noosphere-hook-installer-'));
  temporary.push(home);
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`);
  return home;
}

async function install(home) {
  return execFileAsync(process.execPath, [INSTALLER], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: home },
    timeout: 15_000,
  });
}

function noosphereHooks(settings, event, script) {
  return (settings.hooks[event] || [])
    .flatMap((group) => Array.isArray(group?.hooks) ? group.hooks : [])
    .filter((hook) => typeof hook?.command === 'string' && hook.command.includes(script));
}

describe('Claude hook installer', () => {
  it('collapses duplicate current and legacy hooks while preserving unrelated hooks', async () => {
    const unrelatedPrompt = { type: 'command', command: 'prompt-other', timeout: 3 };
    const unrelatedSession = { type: 'command', command: 'session-other', timeout: 4 };
    const home = await homeWithSettings({
      hooks: {
        UserPromptSubmit: [
          { matcher: 'one', hooks: [
            unrelatedPrompt,
            { type: 'command', command: `"${process.execPath}" "${path.join(homePlaceholder(), 'hooks', 'noosphere', 'capture-prompt.js')}"` },
          ] },
          { hooks: [{ type: 'command', command: `"${process.execPath}" "${path.join(homePlaceholder(), 'hooks', 'noosphere', 'capture-prompt.js')}"` }] },
        ],
        SessionEnd: [
          { matcher: 'end', hooks: [unrelatedSession, { type: 'command', command: 'NOOSPHERE_SESSION_COMMAND' }] },
          { hooks: [{ type: 'command', command: 'NOOSPHERE_LEGACY_COMMAND' }] },
        ],
      },
    });
    const settingsPath = path.join(home, 'settings.json');
    const initial = JSON.parse(await readFile(settingsPath, 'utf8'));
    const currentPrompt = `"${process.execPath}" "${path.join(home, 'hooks', 'noosphere', 'capture-prompt.js')}"`;
    const currentSession = `"${process.execPath}" "${path.join(home, 'hooks', 'noosphere', 'post-session.js')}"`;
    const legacySession = `bash "${path.join(home, 'hooks', 'noosphere', 'post-session.sh')}"`;
    initial.hooks.UserPromptSubmit[0].hooks[1].command = currentPrompt;
    initial.hooks.UserPromptSubmit[1].hooks[0].command = currentPrompt;
    initial.hooks.SessionEnd[0].hooks[1].command = currentSession;
    initial.hooks.SessionEnd[1].hooks[0].command = legacySession;
    await writeFile(settingsPath, `${JSON.stringify(initial, null, 2)}\n`);

    await install(home);
    await install(home);
    const installed = JSON.parse(await readFile(settingsPath, 'utf8'));

    assert.equal(noosphereHooks(installed, 'UserPromptSubmit', 'capture-prompt.js').length, 1);
    assert.equal(noosphereHooks(installed, 'SessionEnd', 'post-session.js').length, 1);
    assert.equal(
      installed.hooks.UserPromptSubmit.flatMap((group) => group.hooks || []).filter((hook) => hook.command === 'prompt-other').length,
      1,
    );
    assert.equal(
      installed.hooks.SessionEnd.flatMap((group) => group.hooks || []).filter((hook) => hook.command === 'session-other').length,
      1,
    );
    assert.equal(
      installed.hooks.SessionEnd.flatMap((group) => group.hooks || []).filter((hook) => hook.command === legacySession).length,
      0,
    );
  });

  it('refuses an invalid hooks shape without overwriting the settings file', async () => {
    const home = await homeWithSettings({ hooks: [] });
    const settingsPath = path.join(home, 'settings.json');
    const before = await readFile(settingsPath, 'utf8');

    await assert.rejects(install(home), /settings\.hooks must be an object/i);

    assert.equal(await readFile(settingsPath, 'utf8'), before);
  });
});

function homePlaceholder() {
  return '/placeholder';
}
