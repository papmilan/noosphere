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
const launchAgents = path.join(os.homedir(), 'Library', 'LaunchAgents');
const relayerLabel = 'xyz.noosphere.relayer';
const managerLabel = 'xyz.noosphere.manager';

if (action === 'uninstall') {
  await uninstall();
} else if (action === 'doctor') {
  await doctor();
} else {
  await install();
}

async function install() {
  assertMacOs();
  await mkdir(appRoot, { recursive: true, mode: 0o700 });
  await mkdir(binDirectory, { recursive: true, mode: 0o700 });
  await mkdir(logDirectory, { recursive: true, mode: 0o700 });
  await mkdir(launchAgents, { recursive: true });

  await copyRuntime(sourceMcp, installedMcp, [
    'continuity',
    'lifecycle',
    'hooks',
    'mcp-server',
    'package.json',
    'package-lock.json',
    'README.md',
  ]);
  await copyRuntime(sourceRelayer, installedRelayer, [
    'index.js',
    'memory.js',
    'walrus-memory.js',
    'durable-store.js',
    'security.js',
    'scorer.js',
    'public',
    'scoring-policy',
    'package.json',
    'package-lock.json',
    '.env.example',
  ]);

  const sourceEnv = path.join(sourceRelayer, '.env');
  const targetEnv = path.join(installedRelayer, '.env');
  if (await exists(sourceEnv)) {
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
  await writeLaunchAgents();
  await installClaudeHook();
  await bootstrapServices();

  console.log('Noosphere installed for this macOS user.');
  console.log(`Command: ${path.join(binDirectory, 'noosphere')}`);
  console.log('Entering a Git project now initializes and watches it automatically.');
  console.log('Create .noosphere-ignore in a repository to opt out.');
}

async function uninstall() {
  assertMacOs();
  await unload(relayerLabel);
  await unload(managerLabel);
  await removeShellBlock();
  await rm(path.join(launchAgents, `${relayerLabel}.plist`), { force: true });
  await rm(path.join(launchAgents, `${managerLabel}.plist`), { force: true });
  await rm(home, { recursive: true, force: true });
  console.log('Noosphere user installation removed.');
}

async function doctor() {
  const checks = {
    node: process.versions.node,
    installed_cli: await exists(path.join(binDirectory, 'noosphere')),
    relayer_launch_agent: await exists(
      path.join(launchAgents, `${relayerLabel}.plist`),
    ),
    manager_launch_agent: await exists(
      path.join(launchAgents, `${managerLabel}.plist`),
    ),
    credentials: await configuredCredentials(
      path.join(installedRelayer, '.env'),
    ),
  };
  console.log(JSON.stringify(checks, null, 2));
  if (
    !checks.installed_cli ||
    !checks.relayer_launch_agent ||
    !checks.manager_launch_agent ||
    !checks.credentials
  ) {
    process.exitCode = 1;
  }
}

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

async function writeWrapper() {
  const wrapper = `#!/bin/sh
exec "${process.execPath}" "${path.join(
    installedMcp,
    'continuity',
    'index.js',
  )}" "$@"
`;
  const wrapperPath = path.join(binDirectory, 'noosphere');
  await writeFile(wrapperPath, wrapper, { encoding: 'utf8', mode: 0o700 });
}

async function writeShellIntegration() {
  const integrationPath = path.join(home, 'shell.zsh');
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

  const zshrc = path.join(os.homedir(), '.zshrc');
  const start = '# >>> noosphere >>>';
  const end = '# <<< noosphere <<<';
  const block = `${start}\n[ -f "${integrationPath}" ] && source "${integrationPath}"\n${end}`;
  let current = await readFile(zshrc, 'utf8').catch(() => '');
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`);
  current = pattern.test(current)
    ? current.replace(pattern, block)
    : `${current.trimEnd()}${current.trim() ? '\n\n' : ''}${block}\n`;
  await writeFile(zshrc, current, 'utf8');
}

async function writeLaunchAgents() {
  const node = process.execPath;
  await writeFile(
    path.join(launchAgents, `${relayerLabel}.plist`),
    plist({
      label: relayerLabel,
      programArguments: [node, path.join(installedRelayer, 'index.js')],
      workingDirectory: installedRelayer,
      stdout: path.join(logDirectory, 'relayer.log'),
      stderr: path.join(logDirectory, 'relayer.error.log'),
    }),
    'utf8',
  );
  await writeFile(
    path.join(launchAgents, `${managerLabel}.plist`),
    plist({
      label: managerLabel,
      programArguments: [
        node,
        path.join(installedMcp, 'lifecycle', 'manager.js'),
      ],
      workingDirectory: installedMcp,
      stdout: path.join(logDirectory, 'manager.log'),
      stderr: path.join(logDirectory, 'manager.error.log'),
    }),
    'utf8',
  );
}

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

async function bootstrapServices() {
  if (process.env.NOOSPHERE_SKIP_LAUNCHCTL === '1') return;
  await unload(relayerLabel);
  await unload(managerLabel);
  await delay(500);
  await bootstrap(
    path.join(launchAgents, `${relayerLabel}.plist`),
  );
  await bootstrap(
    path.join(launchAgents, `${managerLabel}.plist`),
  );
}

async function unload(label) {
  if (process.env.NOOSPHERE_SKIP_LAUNCHCTL === '1') return;
  await execFileAsync('launchctl', [
    'bootout',
    `gui/${process.getuid()}/${label}`,
  ]).catch(() => undefined);
}

async function bootstrap(plistPath) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await execFileAsync('launchctl', [
        'bootstrap',
        `gui/${process.getuid()}`,
        plistPath,
      ]);
      return;
    } catch (error) {
      lastError = error;
      await delay(attempt * 500);
    }
  }
  throw lastError;
}

async function removeShellBlock() {
  const zshrc = path.join(os.homedir(), '.zshrc');
  const current = await readFile(zshrc, 'utf8').catch(() => '');
  const pattern = /# >>> noosphere >>>[\s\S]*?# <<< noosphere <<<\n?/;
  if (pattern.test(current)) {
    await writeFile(zshrc, current.replace(pattern, ''), 'utf8');
  }
}

function plist({
  label,
  programArguments,
  workingDirectory,
  stdout,
  stderr,
}) {
  const argumentsXml = programArguments
    .map((argument) => `      <string>${xml(argument)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
  <key>WorkingDirectory</key><string>${xml(workingDirectory)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(stdout)}</string>
  <key>StandardErrorPath</key><string>${xml(stderr)}</string>
</dict>
</plist>
`;
}

async function configuredCredentials(file) {
  const contents = await readFile(file, 'utf8').catch(() => '');
  return (
    /^MEMWAL_PRIVATE_KEY=.+$/m.test(contents) &&
    /^MEMWAL_ACCOUNT_ID=.+$/m.test(contents)
  );
}

function assertMacOs() {
  if (process.platform !== 'darwin' && process.env.NOOSPHERE_TEST_PLATFORM !== 'darwin') {
    throw new Error('Automatic lifecycle installation currently supports macOS.');
  }
}

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
