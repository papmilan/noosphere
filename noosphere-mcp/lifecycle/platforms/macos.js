/**
 * macOS platform module — LaunchAgent-based service management.
 * No root or sudo required; services run per-user under ~/Library/LaunchAgents.
 */

import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { exists } from '../util.js';

const execFileAsync = promisify(execFile);

function launchAgentsDir() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents');
}

/**
 * @param {object} opts
 * @param {string} opts.relayerLabel
 * @param {string} opts.managerLabel
 * @param {string} opts.installedMcp
 * @param {string} opts.installedRelayer
 * @param {string} opts.logDirectory
 * @param {string} opts.node
 */
export async function installServices(opts) {
  const { relayerLabel, managerLabel, installedMcp, installedRelayer, logDirectory, node } = opts;
  const launchAgents = launchAgentsDir();
  await mkdir(launchAgents, { recursive: true });
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
      programArguments: [node, path.join(installedMcp, 'lifecycle', 'manager.js')],
      workingDirectory: installedMcp,
      stdout: path.join(logDirectory, 'manager.log'),
      stderr: path.join(logDirectory, 'manager.error.log'),
    }),
    'utf8',
  );
  await bootstrapServices(relayerLabel, managerLabel, launchAgents);
}

/**
 * @param {object} opts
 * @param {string} opts.relayerLabel
 * @param {string} opts.managerLabel
 */
export async function uninstallServices(opts) {
  const { relayerLabel, managerLabel } = opts;
  const launchAgents = launchAgentsDir();
  await unload(relayerLabel);
  await unload(managerLabel);
  await rm(path.join(launchAgents, `${relayerLabel}.plist`), { force: true });
  await rm(path.join(launchAgents, `${managerLabel}.plist`), { force: true });
}

/**
 * @param {object} opts
 * @param {string} opts.relayerLabel
 * @param {string} opts.managerLabel
 * @returns {Promise<object>}
 */
export async function doctorChecks(opts) {
  const { relayerLabel, managerLabel } = opts;
  const launchAgents = launchAgentsDir();
  return {
    relayer_service: await exists(path.join(launchAgents, `${relayerLabel}.plist`)),
    manager_service: await exists(path.join(launchAgents, `${managerLabel}.plist`)),
  };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

async function bootstrapServices(relayerLabel, managerLabel, launchAgents) {
  if (process.env.NOOSPHERE_SKIP_LAUNCHCTL === '1') return;
  await unload(relayerLabel);
  await unload(managerLabel);
  await delay(500);
  await bootstrap(path.join(launchAgents, `${relayerLabel}.plist`));
  await bootstrap(path.join(launchAgents, `${managerLabel}.plist`));
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

function plist({ label, programArguments, workingDirectory, stdout, stderr }) {
  const argumentsXml = programArguments
    .map((arg) => `      <string>${xml(arg)}</string>`)
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

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
