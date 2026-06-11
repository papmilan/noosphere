/**
 * Linux platform module — systemd --user service management.
 * No root required; services are managed via `systemctl --user`.
 * Services live in ~/.config/systemd/user/.
 *
 * Guard: if $XDG_RUNTIME_DIR is not set, systemctl calls are skipped
 * (allows tests without dbus/systemd available).
 */

import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { exists } from '../util.js';

const execFileAsync = promisify(execFile);

function systemdUserDir() {
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdgConfig, 'systemd', 'user');
}

function hasSystemd() {
  return (
    process.env.NOOSPHERE_SKIP_SYSTEMCTL !== '1' &&
    Boolean(process.env.XDG_RUNTIME_DIR)
  );
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
  const serviceDir = systemdUserDir();
  await mkdir(serviceDir, { recursive: true, mode: 0o700 });

  await writeFile(
    path.join(serviceDir, `${relayerLabel}.service`),
    serviceUnit({
      description: 'Noosphere Relayer',
      execStart: `${node} ${path.join(installedRelayer, 'index.js')}`,
      workingDirectory: installedRelayer,
      stdout: path.join(logDirectory, 'relayer.log'),
      stderr: path.join(logDirectory, 'relayer.error.log'),
    }),
    'utf8',
  );

  await writeFile(
    path.join(serviceDir, `${managerLabel}.service`),
    serviceUnit({
      description: 'Noosphere Manager',
      execStart: `${node} ${path.join(installedMcp, 'lifecycle', 'manager.js')}`,
      workingDirectory: installedMcp,
      stdout: path.join(logDirectory, 'manager.log'),
      stderr: path.join(logDirectory, 'manager.error.log'),
    }),
    'utf8',
  );

  if (!hasSystemd()) {
    console.warn(
      'Warning: $XDG_RUNTIME_DIR is not set; skipping systemctl calls. ' +
      'Run `systemctl --user daemon-reload && systemctl --user enable --now ' +
      `${relayerLabel} ${managerLabel}` +
      '` manually when a user session is available.',
    );
    return;
  }

  await systemctl('daemon-reload');
  await systemctl('enable', '--now', relayerLabel, managerLabel);
}

/**
 * @param {object} opts
 * @param {string} opts.relayerLabel
 * @param {string} opts.managerLabel
 */
export async function uninstallServices(opts) {
  const { relayerLabel, managerLabel } = opts;
  const serviceDir = systemdUserDir();

  if (hasSystemd()) {
    await systemctl('disable', '--now', relayerLabel, managerLabel).catch(() => undefined);
    await systemctl('daemon-reload').catch(() => undefined);
  }

  await rm(path.join(serviceDir, `${relayerLabel}.service`), { force: true });
  await rm(path.join(serviceDir, `${managerLabel}.service`), { force: true });
}

/**
 * @param {object} opts
 * @param {string} opts.relayerLabel
 * @param {string} opts.managerLabel
 * @returns {Promise<object>}
 */
export async function doctorChecks(opts) {
  const { relayerLabel, managerLabel } = opts;
  const serviceDir = systemdUserDir();

  const relayerFileExists = await exists(path.join(serviceDir, `${relayerLabel}.service`));
  const managerFileExists = await exists(path.join(serviceDir, `${managerLabel}.service`));

  let relayerActive = false;
  let managerActive = false;

  if (hasSystemd()) {
    relayerActive = await isActive(relayerLabel);
    managerActive = await isActive(managerLabel);
  }

  return {
    relayer_service: relayerFileExists && relayerActive,
    manager_service: managerFileExists && managerActive,
  };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

async function systemctl(...args) {
  return execFileAsync('systemctl', ['--user', ...args]);
}

async function isActive(serviceName) {
  try {
    await systemctl('is-active', serviceName);
    return true;
  } catch {
    return false;
  }
}

function serviceUnit({ description, execStart, workingDirectory, stdout, stderr }) {
  return `[Unit]
Description=${description}
After=default.target

[Service]
Type=simple
ExecStart=${execStart}
WorkingDirectory=${workingDirectory}
Restart=always
RestartSec=10
StandardOutput=append:${stdout}
StandardError=append:${stderr}

[Install]
WantedBy=default.target
`;
}
