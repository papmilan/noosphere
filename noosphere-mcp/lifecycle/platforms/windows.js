/**
 * Windows platform module — Task Scheduler service management.
 * No UAC or administrator elevation required; tasks are per-user
 * (LeastPrivilege). Task definitions live in ~/.noosphere/tasks/, the
 * counterpart to the launchd plists and systemd units on the other platforms.
 *
 * Guard: NOOSPHERE_SKIP_SCHTASKS=1 skips all schtasks.exe calls
 * (allows tests on non-Windows hosts).
 */

import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { noosphereHome } from '../registry.js';

const execFileAsync = promisify(execFile);

const TASK_FOLDER = 'Noosphere';

function skipSchtasks() {
  return process.env.NOOSPHERE_SKIP_SCHTASKS === '1';
}

function taskDefinitionDir() {
  return path.join(noosphereHome(), 'tasks');
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

  const definitionDir = taskDefinitionDir();
  await mkdir(definitionDir, { recursive: true, mode: 0o700 });

  const relayerXml = path.join(definitionDir, 'Relayer.xml');
  const managerXml = path.join(definitionDir, 'Manager.xml');

  await writeTaskDefinition(relayerXml, {
    description: 'Noosphere Relayer',
    command: node,
    argument: path.join(installedRelayer, 'index.js'),
    workingDirectory: installedRelayer,
  });
  await writeTaskDefinition(managerXml, {
    description: 'Noosphere Manager',
    command: node,
    argument: path.join(installedMcp, 'lifecycle', 'manager.js'),
    workingDirectory: installedMcp,
  });

  if (!skipSchtasks()) {
    await schtasks('/Create', '/TN', relayerTn, '/XML', relayerXml, '/F');
    await schtasks('/Create', '/TN', managerTn, '/XML', managerXml, '/F');
    // Start them immediately. Failures here aren't fatal — the tasks
    // still run on next logon — but surface a warning so the user knows
    // they need to log out/in or kick them by hand.
    await schtasks('/Run', '/TN', relayerTn).catch((error) => {
      console.warn(
        `Warning: failed to start ${relayerTn} immediately (${error.message}). ` +
        'It will start on next logon, or run: ' +
        `schtasks /Run /TN "${relayerTn}"`,
      );
    });
    await schtasks('/Run', '/TN', managerTn).catch((error) => {
      console.warn(
        `Warning: failed to start ${managerTn} immediately (${error.message}). ` +
        'It will start on next logon, or run: ' +
        `schtasks /Run /TN "${managerTn}"`,
      );
    });
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

/**
 * Write one Task Scheduler definition.
 *
 * schtasks /TR cannot express a working directory, so a task registered that
 * way runs from %SystemRoot%\system32. The relayer loads its .env — and the
 * relative state paths that .env declares — from the current directory, so it
 * silently fell back to built-in defaults and reported itself not ready.
 * launchd and systemd already pin WorkingDirectory; /XML is the only way to
 * say the same thing to the Task Scheduler.
 */
async function writeTaskDefinition(file, definition) {
  // schtasks /XML rejects UTF-8 without a byte order mark. UTF-16LE with a
  // BOM is what Task Scheduler itself exports, so it always round-trips.
  await writeFile(file, `﻿${taskXml(definition)}`, 'utf16le');
}

function taskXml({ description, command, argument, workingDirectory }) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xml(description)}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <StartWhenAvailable>true</StartWhenAvailable>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <!-- Both tasks are daemons. The Task Scheduler default of PT72H would
         terminate them after three days; launchd and systemd keep them up. -->
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(command)}</Command>
      <Arguments>"${xml(argument)}"</Arguments>
      <WorkingDirectory>${xml(workingDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function schtasks(...args) {
  try {
    return await execFileAsync('schtasks.exe', args);
  } catch (error) {
    error.commandLine = `schtasks.exe ${args
      .map((argument) => (/\s/.test(argument) ? `"${argument}"` : argument))
      .join(' ')}`;
    throw error;
  }
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
