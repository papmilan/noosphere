#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readRegistry } from './registry.js';
import { canStart, recordExit } from './restart-policy.js';
import { recordManagerStart } from './service-state.js';

const directory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(directory, '..');
const cli = path.resolve(directory, '..', 'continuity', 'index.js');
const ideBridge = path.resolve(directory, 'ide-bridge.js');
const children = new Map();
// path -> { consecutiveFailures, retryAt } for watchers that exited non-zero.
const restarts = new Map();
const pollMs = Number(process.env.NOOSPHERE_MANAGER_POLL_MS || 5_000);
let stopping = false;
let ideBridgeChild = null;

// Optionally start the IDE bridge as a child process (opt-in only).
if (process.env.NOOSPHERE_ENABLE_IDE_BRIDGE === '1') {
  startIdeBridge();
}

// Stamp which build this process loaded so `noosphere doctor` can tell a
// running service apart from a running *current* service. Never fatal: an
// unwritable marker costs a diagnostic, not the manager.
await recordManagerStart(packageRoot).catch((error) => {
  console.error(`[manager] Could not record runtime marker: ${error.message}`);
});

await reconcile();
const timer = setInterval(() => {
  void reconcile();
}, pollMs);

process.once('SIGINT', stop);
process.once('SIGTERM', stop);

async function reconcile() {
  if (stopping) return;
  const registry = await readRegistry();
  const enabled = new Map(
    registry.projects
      .filter((project) => project.enabled !== false)
      .map((project) => [project.path, project]),
  );

  for (const [root, child] of children) {
    if (!enabled.has(root)) {
      child.kill('SIGTERM');
      children.delete(root);
      restarts.delete(root);
    }
  }

  for (const root of restarts.keys()) {
    if (!enabled.has(root)) restarts.delete(root);
  }

  for (const project of enabled.values()) {
    if (children.has(project.path)) continue;
    if (!(await exists(project.path))) continue;
    // A watcher that keeps failing at startup is backed off rather than
    // respawned every reconcile tick.
    if (!canStart(restarts.get(project.path))) continue;
    startWatcher(project);
  }
}

function startIdeBridge() {
  if (ideBridgeChild || stopping) return;
  const child = spawn(process.execPath, [ideBridge], {
    env: { ...process.env },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  ideBridgeChild = child;
  console.log('[manager] IDE bridge started');
  child.once('exit', (code, signal) => {
    if (ideBridgeChild === child) ideBridgeChild = null;
    if (!stopping) {
      console.error(
        `[manager] IDE bridge exited (${signal || code}), restarting in 5 s`,
      );
      setTimeout(() => {
        if (!stopping) startIdeBridge();
      }, 5_000).unref();
    }
  });
}

function startWatcher(project) {
  const startedAt = Date.now();
  const child = spawn(process.execPath, [cli, 'watch'], {
    cwd: project.path,
    env: {
      ...process.env,
      NOOSPHERE_PROJECT_DIR: project.path,
      NOOSPHERE_CLIENT: 'system-project-manager',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  children.set(project.path, child);
  console.log(
    `[manager] Watching ${project.project_id} at ${project.path}`,
  );
  child.once('exit', (code, signal) => {
    children.delete(project.path);
    if (stopping) return;
    if (code === 0) {
      restarts.delete(project.path);
      return;
    }
    const record = recordExit(
      restarts.get(project.path),
      Date.now() - startedAt,
    );
    restarts.set(project.path, record);
    console.error(
      `[manager] Watcher exited for ${project.path} (${signal || code}); ` +
        `retry ${record.consecutiveFailures} in ${Math.round(
          (record.retryAt - Date.now()) / 1000,
        )} s`,
    );
  });
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  for (const child of children.values()) child.kill('SIGTERM');
  children.clear();
  if (ideBridgeChild) ideBridgeChild.kill('SIGTERM');
  ideBridgeChild = null;
  setTimeout(() => process.exit(0), 100).unref();
}
