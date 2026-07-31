// Whether the manager that is *running* is the manager that is *installed*.
//
// Only the macOS installer stops the old service before starting the new one.
// The Linux and Windows paths start a service that may already be running, so
// an upgrade can copy new code into place, report success, and leave the old
// process serving indefinitely. Nothing observable distinguishes that from a
// healthy install, which makes it read as "the fix did not work".
//
// The manager stamps what it loaded at startup; doctor compares that stamp
// against what is on disk now. A newer stamp on disk means the running process
// predates the installed code.

import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { noosphereHome } from './registry.js';

export function runtimeMarkerPath(env = process.env) {
  return path.join(noosphereHome(env), 'manager-runtime.json');
}

// package.json is copied on every install and `fs.cp` does not preserve
// timestamps, so its mtime moves whenever new code lands.
export async function sourceStamp(packageRoot) {
  const { mtimeMs } = await stat(path.join(packageRoot, 'package.json'));
  return Math.round(mtimeMs);
}

export async function recordManagerStart(packageRoot, env = process.env) {
  const marker = {
    pid: process.pid,
    started_at: new Date().toISOString(),
    source_root: path.resolve(packageRoot),
    source_stamp: await sourceStamp(packageRoot),
  };
  await writeFile(
    runtimeMarkerPath(env),
    `${JSON.stringify(marker, null, 2)}\n`,
    { mode: 0o600 },
  );
  return marker;
}

export async function readManagerMarker(env = process.env) {
  try {
    return JSON.parse(await readFile(runtimeMarkerPath(env), 'utf8'));
  } catch {
    return null;
  }
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs the permission and existence check without delivering
    // anything, and is the one signal number Windows also honours.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to somebody else.
    return error.code === 'EPERM';
  }
}

// true = running older code than what is installed, false = current,
// null = cannot tell (no marker, marker from a different install root, or a
// manager that is not running at all). Unknown must never read as a failure.
export function isStale(marker, currentStamp, packageRoot) {
  if (!marker || typeof marker.source_stamp !== 'number') return null;
  if (typeof currentStamp !== 'number') return null;
  if (
    packageRoot &&
    marker.source_root &&
    path.resolve(packageRoot) !== path.resolve(marker.source_root)
  ) {
    // A manager started from a checkout is not evidence about the installed
    // copy; comparing them would report a phantom upgrade.
    return null;
  }
  if (!isProcessAlive(marker.pid)) return null;
  return currentStamp > marker.source_stamp;
}
