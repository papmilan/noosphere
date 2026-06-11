/**
 * Windows platform module — Task Scheduler service management.
 * No UAC or administrator elevation required; tasks are per-user (/RL LIMITED).
 *
 * Guard: NOOSPHERE_SKIP_SCHTASKS=1 skips all schtasks.exe calls
 * (allows tests on non-Windows hosts).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const TASK_FOLDER = 'Noosphere';

function skipSchtasks() {
  return process.env.NOOSPHERE_SKIP_SCHTASKS === '1';
}

/**
 * Quote a Windows path for use inside a Task Scheduler /TR argument.
 * We use double-quotes around each part.
 */
function winQuote(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

/**
 * @param {object} opts
 * @param {string} opts.relayerLabel
 * @param {string} opts.managerLabel
 * @param {string} opts.installedMcp
 * @param {string} opts.installedRelayer
 * @param {string} opts.node
 */
export async function installServices(opts) {
  const { installedMcp, installedRelayer, node } = opts;

  const relayerTn = `${TASK_FOLDER}\\Relayer`;
  const managerTn = `${TASK_FOLDER}\\Manager`;

  if (!skipSchtasks()) {
    await schtasks(
      '/Create',
      '/TN', relayerTn,
      '/TR', `${winQuote(node)} ${winQuote(`${installedRelayer}\\index.js`)}`,
      '/SC', 'ONLOGON',
      '/RL', 'LIMITED',
      '/F',
    );
    await schtasks(
      '/Create',
      '/TN', managerTn,
      '/TR', `${winQuote(node)} ${winQuote(`${installedMcp}\\lifecycle\\manager.js`)}`,
      '/SC', 'ONLOGON',
      '/RL', 'LIMITED',
      '/F',
    );
    // Start them immediately
    await schtasks('/Run', '/TN', relayerTn).catch(() => undefined);
    await schtasks('/Run', '/TN', managerTn).catch(() => undefined);
  }

  // Record the task names so doctor/uninstall can find them
  opts._relayerTn = relayerTn;
  opts._managerTn = managerTn;
}

/**
 * @param {object} opts
 * @param {string} opts.relayerLabel
 * @param {string} opts.managerLabel
 */
export async function uninstallServices(opts) {
  if (skipSchtasks()) return;
  const relayerTn = `${TASK_FOLDER}\\Relayer`;
  const managerTn = `${TASK_FOLDER}\\Manager`;
  await schtasks('/Delete', '/TN', relayerTn, '/F').catch(() => undefined);
  await schtasks('/Delete', '/TN', managerTn, '/F').catch(() => undefined);
}

/**
 * @param {object} opts
 * @returns {Promise<object>}
 */
export async function doctorChecks(_opts) {
  const relayerTn = `${TASK_FOLDER}\\Relayer`;
  const managerTn = `${TASK_FOLDER}\\Manager`;

  return {
    relayer_service: await taskExists(relayerTn),
    manager_service: await taskExists(managerTn),
  };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

async function schtasks(...args) {
  return execFileAsync('schtasks.exe', args);
}

async function taskExists(taskName) {
  if (skipSchtasks()) return false;
  try {
    await schtasks('/Query', '/TN', taskName, '/FO', 'CSV', '/NH');
    return true;
  } catch {
    return false;
  }
}
