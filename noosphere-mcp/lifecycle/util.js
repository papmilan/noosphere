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
