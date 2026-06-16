/**
 * Shared utility functions for the lifecycle installer.
 */

import { access } from 'node:fs/promises';

export async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolve the platform-specific executable name for an npm-style shim.
 * On Windows, `npm`, `npx`, `yarn`, `pnpm` live as `.cmd` batch files.
 * Node's child_process.spawn does not auto-append `.cmd`/`.bat` via
 * PATHEXT when `shell: false`, so we must pass the full filename.
 */
export function npmStyleCommand(name, platform = process.platform) {
  return platform === 'win32' ? `${name}.cmd` : name;
}

export function npmCommand(platform = process.platform) {
  return npmStyleCommand('npm', platform);
}
