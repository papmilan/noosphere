// Size-capped service logs.
//
// launchd and systemd own the log file descriptors — the services just write to
// stdout and stderr. That rules out the usual rename-then-recreate rotation:
// the writer would keep appending to the renamed inode and the fresh file would
// stay empty until the service restarted. Only the *contents* can move.
//
// So this copies the file aside and truncates the original in place, which is
// what `logrotate copytruncate` does and for the same reason. The file keeps
// its inode, the open descriptors stay valid, and writing continues normally.
//
// The tradeoff is a narrow race: anything written between the copy and the
// truncate is lost. For diagnostic logs that is the right trade against
// requiring every writer to cooperate with a reopen protocol.

import { chmod, copyFile, readdir, stat, truncate } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export function maxLogBytes(env = process.env) {
  const configured = Number(env.NOOSPHERE_LOG_MAX_BYTES);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_BYTES;
}

// Rotates one file if it has outgrown the cap. Returns true when it rotated.
export async function rotateFile(file, maxBytes = DEFAULT_MAX_BYTES) {
  let size;
  try {
    ({ size } = await stat(file));
  } catch {
    return false;
  }
  if (size <= maxBytes) return false;

  // A single previous generation. Disk stays bounded at roughly 2x the cap per
  // log, which is the point of doing this at all.
  const previous = `${file}.1`;
  await copyFile(file, previous);
  await chmod(previous, 0o600).catch(() => undefined);
  await truncate(file, 0);
  return true;
}

// Rotates every *.log in the directory. Generations end in `.log.1`, which does
// not match, so they are never rotated again.
export async function rotateLogs(logDirectory, maxBytes = DEFAULT_MAX_BYTES) {
  let entries;
  try {
    entries = await readdir(logDirectory);
  } catch {
    return [];
  }
  const rotated = [];
  for (const entry of entries) {
    if (!entry.endsWith('.log')) continue;
    if (await rotateFile(path.join(logDirectory, entry), maxBytes)) {
      rotated.push(entry);
    }
  }
  return rotated;
}
