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
 * Resolve the filename of the CLI wrapper in ~/.noosphere/bin. Windows needs
 * the `.cmd` extension for the shim to run from cmd.exe and PowerShell.
 * Every caller must agree on this name: the installer writes it, and doctor
 * checks for it. NOOSPHERE_TEST_PLATFORM supplies `windows`, so both that
 * spelling and Node's own `win32` have to resolve the same way.
 */
export function wrapperName(platform = process.platform) {
  return platform === 'win32' || platform === 'windows'
    ? 'noosphere.cmd'
    : 'noosphere';
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

/**
 * Options to merge into child_process spawn/execFile when invoking an
 * npm-style shim. On Windows, Node refuses to spawn .cmd/.bat files
 * directly since the 18.20.2/20.12.2/21.7.3 CVE-2024-27980 mitigation
 * unless `shell: true` is set. POSIX hosts don't need it.
 */
export function npmSpawnOptions(platform = process.platform) {
  return { shell: platform === 'win32' };
}
