#!/usr/bin/env node

import { execFile } from 'node:child_process';
import {
  access,
  appendFile,
  chmod,
  cp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { noosphereHome } from './registry.js';
import { CredentialStore } from './credentials.js';
import { escapeRegExp, exists } from './util.js';

const execFileAsync = promisify(execFile);
const directory = path.dirname(fileURLToPath(import.meta.url));
const sourceMcp = path.resolve(directory, '..');
const sourceRoot = path.resolve(sourceMcp, '..');
const sourceRelayer = path.join(sourceRoot, 'noosphere-relayer');
const action = process.argv[2] || 'install';
const home = noosphereHome();
const appRoot = path.join(home, 'app');
const installedMcp = path.join(appRoot, 'noosphere-mcp');
const installedRelayer = path.join(appRoot, 'noosphere-relayer');
const binDirectory = path.join(home, 'bin');
const logDirectory = path.join(home, 'logs');
const shellDirectory = home; // shell fragments live in ~/.noosphere/
const relayerLabel = 'xyz.noosphere.relayer';
const managerLabel = 'xyz.noosphere.manager';
const node = process.execPath;

// Shell block guard markers — must be declared before the entry-point await.
const GUARD_START = '# >>> noosphere >>>';
const GUARD_END = '# <<< noosphere <<<';

// ---------------------------------------------------------------------------
// Platform selection
// ---------------------------------------------------------------------------

const effectivePlatform =
  process.env.NOOSPHERE_TEST_PLATFORM || process.platform;

async function getPlatformModule() {
  switch (effectivePlatform) {
    case 'darwin':
      return import('./platforms/macos.js');
    case 'linux':
      return import('./platforms/linux.js');
    case 'win32':
    case 'windows':
      return import('./platforms/windows.js');
    default:
      throw new Error(
        `Unsupported platform: ${effectivePlatform}. ` +
        'Noosphere lifecycle management supports macOS, Linux, and Windows.',
      );
  }
}

const platformOpts = {
  relayerLabel,
  managerLabel,
  installedMcp,
  installedRelayer,
  logDirectory,
  node,
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (action === 'uninstall') {
  await uninstall();
} else if (action === 'doctor') {
  await doctor();
} else {
  await install();
}

// ---------------------------------------------------------------------------
// Top-level commands
// ---------------------------------------------------------------------------

async function install() {
  await mkdir(appRoot, { recursive: true, mode: 0o700 });
  await mkdir(binDirectory, { recursive: true, mode: 0o700 });
  await mkdir(logDirectory, { recursive: true, mode: 0o700 });

  await copyRuntime(sourceMcp, installedMcp, [
    'continuity',
    'lifecycle',
    'hooks',
    'mcp-server',
    'package.json',
    'package-lock.json',
    'README.md',
  ]);
  // Ensure ide-bridge.js is always present in the installed lifecycle directory.
  // copyRuntime copies the entire 'lifecycle' folder above, so this is a
  // belt-and-suspenders guard that survives partial copies or future
  // restructuring that might list individual lifecycle files.
  await copyRuntime(
    path.join(sourceMcp, 'lifecycle'),
    path.join(installedMcp, 'lifecycle'),
    ['ide-bridge.js'],
  );
  await copyRuntime(sourceRelayer, installedRelayer, [
    'index.js',
    'memory.js',
    'walrus-memory.js',
    'durable-store.js',
    'security.js',
    'scorer.js',
    'local-projects.js',
    'credentials.js',
    'public',
    'scoring-policy',
    'package.json',
    'package-lock.json',
    '.env.example',
  ]);

  const sourceEnv = path.join(sourceRelayer, '.env');
  const targetEnv = path.join(installedRelayer, '.env');
  if (await exists(sourceEnv) && !(await exists(targetEnv))) {
    await cp(sourceEnv, targetEnv, { force: true });
    await chmod(targetEnv, 0o600);
  } else if (!(await exists(targetEnv))) {
    await cp(path.join(installedRelayer, '.env.example'), targetEnv);
    await chmod(targetEnv, 0o600);
  }

  if (process.env.NOOSPHERE_SKIP_NPM !== '1') {
    await execFileAsync('npm', ['ci', '--omit=dev'], {
      cwd: installedRelayer,
    });
  }

  await writeWrapper();
  await writeShellIntegration();

  const platform = await getPlatformModule();
  await platform.installServices(platformOpts);

  await installClaudeHook();

  const platformName =
    effectivePlatform === 'darwin'
      ? 'macOS'
      : effectivePlatform === 'linux'
      ? 'Linux'
      : 'Windows';
  console.log(`Noosphere installed for this ${platformName} user.`);
  console.log(`Command: ${path.join(binDirectory, 'noosphere')}`);
  console.log('Entering a Git project now initializes and watches it automatically.');
  console.log('Create .noosphere-ignore in a repository to opt out.');
}

async function uninstall() {
  const platform = await getPlatformModule();
  await platform.uninstallServices(platformOpts);
  await removeAllShellBlocks();
  await rm(home, { recursive: true, force: true });
  console.log('Noosphere user installation removed.');
}

async function doctor() {
  const platform = await getPlatformModule();
  const platformChecks = await platform.doctorChecks(platformOpts);

  const checks = {
    node: process.versions.node,
    platform: effectivePlatform,
    installed_cli: await exists(path.join(binDirectory, 'noosphere')),
    ...platformChecks,
    credentials: await configuredCredentials(path.join(installedRelayer, '.env')),
  };

  console.log(JSON.stringify(checks, null, 2));

  if (
    !checks.installed_cli ||
    !checks.relayer_service ||
    !checks.manager_service ||
    !checks.credentials
  ) {
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// File copying
// ---------------------------------------------------------------------------

async function copyRuntime(source, destination, entries) {
  if (path.resolve(source) === path.resolve(destination)) return;
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    const from = path.join(source, entry);
    if (await exists(from)) {
      await cp(from, path.join(destination, entry), {
        recursive: true,
        force: true,
        filter: (file) =>
          !path.basename(file).startsWith('._') &&
          path.basename(file) !== 'node_modules',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

async function writeWrapper() {
  const wrapperContent =
    effectivePlatform === 'win32' || effectivePlatform === 'windows'
      ? `@echo off\n"${node}" "${path.join(installedMcp, 'continuity', 'index.js')}" %*\n`
      : `#!/bin/sh\nexec "${node}" "${path.join(installedMcp, 'continuity', 'index.js')}" "$@"\n`;

  const wrapperName =
    effectivePlatform === 'win32' || effectivePlatform === 'windows'
      ? 'noosphere.cmd'
      : 'noosphere';

  const wrapperPath = path.join(binDirectory, wrapperName);
  await writeFile(wrapperPath, wrapperContent, { encoding: 'utf8', mode: 0o700 });
}

// ---------------------------------------------------------------------------
// Shell integration — multi-shell
// ---------------------------------------------------------------------------

/**
 * Write shell fragment files and inject rc-file blocks for every shell
 * whose rc file already exists.
 */
async function writeShellIntegration() {
  await mkdir(shellDirectory, { recursive: true, mode: 0o700 });

  await writeZshIntegration();
  await writeBashIntegration();
  await writeFishIntegration();
  await writePowerShellIntegration();
}

// ---- zsh -------------------------------------------------------------------

async function writeZshIntegration() {
  const integrationPath = path.join(shellDirectory, 'shell.zsh');
  await writeFile(
    integrationPath,
    `# Noosphere automatic project activation
export PATH="${binDirectory}:$PATH"
_noosphere_auto_activate() {
  command noosphere activate --quiet >/dev/null 2>&1 &!
}
autoload -Uz add-zsh-hook
add-zsh-hook chpwd _noosphere_auto_activate
add-zsh-hook precmd _noosphere_auto_activate
`,
    'utf8',
  );

  const rcFile = path.join(os.homedir(), '.zshrc');
  const block = `[ -f "${integrationPath}" ] && source "${integrationPath}"`;
  await injectShellBlock(rcFile, block);
}

// ---- bash ------------------------------------------------------------------

async function writeBashIntegration() {
  const integrationPath = path.join(shellDirectory, 'shell.bash');
  await writeFile(
    integrationPath,
    `# Noosphere automatic project activation
export PATH="${binDirectory}:$PATH"
_noosphere_auto_activate() {
  command noosphere activate --quiet >/dev/null 2>&1 &
}
if [[ -n "$PROMPT_COMMAND" ]]; then
  PROMPT_COMMAND="_noosphere_auto_activate;$PROMPT_COMMAND"
else
  PROMPT_COMMAND="_noosphere_auto_activate"
fi
`,
    'utf8',
  );

  const rcFile = path.join(os.homedir(), '.bashrc');
  const block = `[ -f "${integrationPath}" ] && source "${integrationPath}"`;
  await injectShellBlock(rcFile, block);
}

// ---- fish ------------------------------------------------------------------

async function writeFishIntegration() {
  const integrationPath = path.join(shellDirectory, 'shell.fish');
  await writeFile(
    integrationPath,
    `# Noosphere automatic project activation
fish_add_path "${binDirectory}"

function _noosphere_auto_activate
  command noosphere activate --quiet >/dev/null 2>&1 &
end

function cd
  builtin cd $argv
  and _noosphere_auto_activate
end
`,
    'utf8',
  );

  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const rcFile = path.join(xdgConfig, 'fish', 'config.fish');
  const block = `[ -f "${integrationPath}" ] && source "${integrationPath}"`;
  await injectShellBlock(rcFile, block);
}

// ---- PowerShell ------------------------------------------------------------

async function writePowerShellIntegration() {
  const integrationPath = path.join(shellDirectory, 'shell.ps1');
  const noosphereCmd = path.join(binDirectory, 'noosphere.cmd');
  await writeFile(
    integrationPath,
    `# Noosphere automatic project activation
$env:PATH = "${binDirectory}" + [IO.Path]::PathSeparator + $env:PATH

function Invoke-NoosphereActivate {
  & "${noosphereCmd}" activate --quiet 2>$null
}

# Override Set-Location (cd) to trigger activation
$ExecutionContext.SessionState.InvokeCommand.PostCommandLookupAction = {
  param($CommandName, $CommandLookupEventArgs)
  if ($CommandName -in 'Set-Location', 'cd', 'chdir', 'sl') {
    $OriginalCommand = $CommandLookupEventArgs.Command
    $CommandLookupEventArgs.CommandScriptBlock = {
      & $OriginalCommand @args
      Invoke-NoosphereActivate
    }.GetNewClosure()
  }
}
`,
    'utf8',
  );

  // Resolve the PowerShell profile path
  const psProfile = await resolvePowerShellProfile();
  if (psProfile) {
    const block = `. "${integrationPath}"`;
    await injectShellBlock(psProfile, block);
  }
}

async function resolvePowerShellProfile() {
  // Common PowerShell profile locations
  const candidates = [];

  if (effectivePlatform === 'win32' || effectivePlatform === 'windows') {
    const docs = process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, 'Documents')
      : path.join(os.homedir(), 'Documents');
    candidates.push(
      path.join(docs, 'PowerShell', 'Microsoft.PowerShell_profile.ps1'),
      path.join(docs, 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'),
    );
  } else {
    // macOS / Linux — PowerShell Core
    const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    candidates.push(
      path.join(xdgConfig, 'powershell', 'Microsoft.PowerShell_profile.ps1'),
      path.join(os.homedir(), '.config', 'powershell', 'Microsoft.PowerShell_profile.ps1'),
    );
  }

  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return null; // No existing profile — skip injection
}

// ---- shared block injection ------------------------------------------------

/**
 * Inject or replace the noosphere block in an existing rc file.
 * If the file does not exist, this is a no-op (we never create rc files).
 */
async function injectShellBlock(rcFile, innerBlock) {
  if (!(await exists(rcFile))) return;
  const block = `${GUARD_START}\n${innerBlock}\n${GUARD_END}`;
  let current = await readFile(rcFile, 'utf8').catch(() => '');
  const pattern = new RegExp(
    `${escapeRegExp(GUARD_START)}[\\s\\S]*?${escapeRegExp(GUARD_END)}`,
  );
  current = pattern.test(current)
    ? current.replace(pattern, block)
    : `${current.trimEnd()}${current.trim() ? '\n\n' : ''}${block}\n`;
  await writeFile(rcFile, current, 'utf8');
}

// ---------------------------------------------------------------------------
// Shell block removal
// ---------------------------------------------------------------------------

async function removeAllShellBlocks() {
  const rcFiles = [
    path.join(os.homedir(), '.zshrc'),
    path.join(os.homedir(), '.bashrc'),
  ];

  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  rcFiles.push(path.join(xdgConfig, 'fish', 'config.fish'));

  // PowerShell profile
  const psProfile = await resolvePowerShellProfile();
  if (psProfile) rcFiles.push(psProfile);

  const pattern = /# >>> noosphere >>>[\s\S]*?# <<< noosphere <<<\n?/g;

  for (const rcFile of rcFiles) {
    if (!(await exists(rcFile))) continue;
    const current = await readFile(rcFile, 'utf8').catch(() => '');
    if (pattern.test(current)) {
      await writeFile(rcFile, current.replace(pattern, ''), 'utf8');
    }
    pattern.lastIndex = 0; // reset stateful regex
  }
}

// ---------------------------------------------------------------------------
// Claude hook
// ---------------------------------------------------------------------------

async function installClaudeHook() {
  if (process.env.NOOSPHERE_SKIP_CLAUDE_HOOK === '1') return;
  const script = path.join(installedMcp, 'hooks', 'install-hook.sh');
  if (await exists(script)) {
    await execFileAsync('bash', [script], {
      env: {
        ...process.env,
        NOOSPHERE_RELAYER_URL: 'http://127.0.0.1:3001',
      },
    }).catch((error) => {
      console.warn(`Claude hook was not installed: ${error.message}`);
    });
  }
}

// ---------------------------------------------------------------------------
// Credentials check
// ---------------------------------------------------------------------------

async function configuredCredentials(file) {
  if (new CredentialStore('default').status().present) return true;
  const contents = await readFile(file, 'utf8').catch(() => '');
  return (
    /^MEMWAL_PRIVATE_KEY=.+$/m.test(contents) &&
    /^MEMWAL_ACCOUNT_ID=.+$/m.test(contents)
  );
}
