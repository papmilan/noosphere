#!/usr/bin/env node
/**
 * ide-bridge.js — IDE project registration bridge for Noosphere.
 *
 * Long-running daemon that polls configured workspace roots for projects
 * containing `.noosphere/ide-hint.json` and registers them automatically.
 *
 * Controlled by:
 *   NOOSPHERE_IDE_POLL_MS   — scan interval in milliseconds (default: 30 000)
 *   NOOSPHERE_HOME          — overrides ~/.noosphere
 *   NOOSPHERE_ENABLE_IDE_BRIDGE — must be "1" to be started by manager.js
 *
 * The bridge never scans the whole computer. It only inspects roots explicitly
 * listed in ~/.noosphere/ide-workspaces.json.
 */

import {
  access,
  mkdir,
  opendir,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { noosphereHome, readRegistry, registerProject } from './registry.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HINT_RELATIVE = path.join('.noosphere', 'ide-hint.json');
const IGNORE_FILE = '.noosphere-ignore';
const MAX_DEPTH = 3;
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.cache',
  'vendor',
]);

// ---------------------------------------------------------------------------
// Workspace root discovery
// ---------------------------------------------------------------------------

/**
 * Read ~/.noosphere/ide-workspaces.json.
 * Returns an array of absolute directory paths.
 * Returns an empty list if the file is missing or empty. Noosphere must not
 * continuously scan a user's home directory.
 */
export async function readWorkspaceRoots(env = process.env) {
  const home = noosphereHome(env);
  const configFile = path.join(home, 'ide-workspaces.json');
  try {
    const raw = JSON.parse(await readFile(configFile, 'utf8'));
    if (Array.isArray(raw.roots) && raw.roots.length > 0) {
      return raw.roots.map((r) => path.resolve(r));
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(
        `[ide-bridge] Could not read ide-workspaces.json: ${error.message}`,
      );
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/**
 * Recursively scan `root` up to MAX_DEPTH directory levels deep.
 * Yields paths of every directory that contains `.noosphere/ide-hint.json`.
 *
 * Rules:
 *  - Never recurse into SKIP_DIRS names.
 *  - Skip any directory (or its subtree) that contains `.noosphere-ignore`
 *    at its own root.
 *  - depth=0 is the workspace root itself; depth=MAX_DEPTH is the last level
 *    we inspect for hint files (we do NOT recurse deeper than MAX_DEPTH).
 */
export async function* scanForHints(root, depth = 0) {
  // Stop recursing past max depth
  if (depth > MAX_DEPTH) return;

  // If this directory itself is opted out, skip it entirely
  if (await exists(path.join(root, IGNORE_FILE))) return;

  // Does this directory have a hint file?
  if (await exists(path.join(root, HINT_RELATIVE))) {
    yield root;
  }

  // Do not recurse *into* children when we've already reached MAX_DEPTH
  if (depth >= MAX_DEPTH) return;

  let dir;
  try {
    dir = await opendir(root);
  } catch {
    return;
  }

  for await (const entry of dir) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    yield* scanForHints(path.join(root, entry.name), depth + 1);
  }
}

// ---------------------------------------------------------------------------
// Hint file I/O
// ---------------------------------------------------------------------------

/**
 * Read `.noosphere/ide-hint.json` from a project directory.
 * Returns the parsed object or null on any error.
 */
export async function readHint(projectRoot) {
  try {
    const raw = await readFile(path.join(projectRoot, HINT_RELATIVE), 'utf8');
    const hint = JSON.parse(raw);
    if (typeof hint.project_id !== 'string' || !hint.project_id) return null;
    return hint;
  } catch {
    return null;
  }
}

/**
 * Write `.noosphere/ide-hint.json` into a project directory.
 * Creates the `.noosphere/` directory if it does not exist.
 * Returns the written hint object.
 */
export async function writeHint(projectRoot, projectId) {
  const noosphereDir = path.join(projectRoot, '.noosphere');
  await mkdir(noosphereDir, { recursive: true });
  const hint = {
    project_id: projectId,
    registered_at: new Date().toISOString(),
  };
  await writeFile(
    path.join(noosphereDir, 'ide-hint.json'),
    `${JSON.stringify(hint, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o644 },
  );
  return hint;
}

// ---------------------------------------------------------------------------
// Registration scan
// ---------------------------------------------------------------------------

/**
 * Scan all workspace roots and register any projects with ide-hint.json.
 * Skips paths already present in the registry (idempotent, no log noise).
 */
export async function scanAndRegister(env = process.env) {
  const roots = await readWorkspaceRoots(env);
  const registry = await readRegistry(env);

  // Build a set of canonical paths already in the registry
  const registeredPaths = new Set(
    registry.projects.map((project) => project.path),
  );

  for (const workspaceRoot of roots) {
    if (!(await exists(workspaceRoot))) continue;

    for await (const projectDir of scanForHints(workspaceRoot)) {
      try {
        const canonical = await toCanonical(projectDir);
        if (registeredPaths.has(canonical)) continue;

        const hint = await readHint(projectDir);
        if (!hint) continue;

        await registerProject(projectDir, hint.project_id, env);
        registeredPaths.add(canonical);
        console.log(
          `[ide-bridge] Registered ${hint.project_id} at ${canonical}`,
        );
      } catch (error) {
        console.warn(
          `[ide-bridge] Could not register ${projectDir}: ${error.message}`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function toCanonical(value) {
  const resolved = path.resolve(value);
  return realpath(resolved).catch(() => resolved);
}

// ---------------------------------------------------------------------------
// Daemon entry point
// ---------------------------------------------------------------------------

// Detect whether this file is the main module so the daemon only starts when
// run directly (not when imported by tests or manager.js).
const thisFile = fileURLToPath(import.meta.url);
const isMain = process.argv[1] && path.resolve(process.argv[1]) === thisFile;

if (isMain) {
  let stopping = false;
  const pollMs = Number(process.env.NOOSPHERE_IDE_POLL_MS || 30_000);

  // First scan is immediate
  await scanAndRegister().catch((error) => {
    console.error(`[ide-bridge] Initial scan error: ${error.message}`);
  });

  const timer = setInterval(async () => {
    if (stopping) return;
    try {
      await scanAndRegister();
    } catch (error) {
      console.error(`[ide-bridge] Scan error: ${error.message}`);
    }
  }, pollMs);

  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    setTimeout(() => process.exit(0), 100).unref();
  };

  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
