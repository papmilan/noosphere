#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { noosphereHome, readRegistry } from './registry.js';
import { maxLogBytes, rotateLogs } from './log-rotation.js';
import { createCoalescedRunner, superviseChild } from './manager-supervision.js';
import { canStart, recordExit } from './restart-policy.js';
import { recordManagerStart } from './service-state.js';
import { windowsProcessOptions } from './util.js';

const directory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(directory, '..');
const cli = path.resolve(directory, '..', 'continuity', 'index.js');
const ideBridge = path.resolve(directory, 'ide-bridge.js');
const children = new Map();
// path -> { consecutiveFailures, retryAt } for watchers that exited non-zero.
const restarts = new Map();
const pollMs = Number(process.env.NOOSPHERE_MANAGER_POLL_MS || 5_000);
const logsDirectory = path.join(noosphereHome(), 'logs');
const logRotateMs = Number(process.env.NOOSPHERE_LOG_ROTATE_MS || 60_000);
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

const reconcileRunner = createCoalescedRunner(reconcile, {
  onError: (error) => {
    console.error(`[manager] Reconciliation failed: ${error.message}`);
  },
});
await reconcileRunner.run();
const timer = setInterval(() => {
  void reconcileRunner.run();
}, pollMs);

// The manager is the only always-running process that can cap these files;
// nothing else outlives a service restart. It rotates the relayer's logs too,
// which needs no cooperation from the relayer because copy-and-truncate leaves
// the descriptors alone.
const logTimer = setInterval(() => {
  void rotateLogs(logsDirectory, maxLogBytes())
    .then((rotated) => {
      for (const name of rotated) console.log(`[manager] Rotated ${name}`);
    })
    .catch((error) => {
      console.error(`[manager] Log rotation failed: ${error.message}`);
    });
}, logRotateMs);
logTimer.unref();

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
    ...windowsProcessOptions(),
  });
  ideBridgeChild = child;
  console.log('[manager] IDE bridge started');
  superviseChild(child, ({ code, signal, error }) => {
    if (ideBridgeChild === child) ideBridgeChild = null;
    if (!stopping) {
      const outcome = error
        ? `${error.code || error.message}`
        : `${signal || code}`;
      console.error(
        `[manager] IDE bridge exited (${outcome}), restarting in 5 s`,
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
    ...windowsProcessOptions(),
  });
  children.set(project.path, child);
  console.log(
    `[manager] Watching ${project.project_id} at ${project.path}`,
  );
  superviseChild(child, ({ code, signal, error }) => {
    if (children.get(project.path) === child) children.delete(project.path);
    if (stopping) return;
    if (!error && code === 0) {
      restarts.delete(project.path);
      return;
    }
    const record = recordExit(
      restarts.get(project.path),
      Date.now() - startedAt,
    );
    restarts.set(project.path, record);
    const outcome = error
      ? `${error.code || error.message}`
      : `${signal || code}`;
    console.error(
      `[manager] Watcher exited for ${project.path} (${outcome}); ` +
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
  clearInterval(logTimer);
  reconcileRunner.stop();
  for (const child of children.values()) child.kill('SIGTERM');
  children.clear();
  if (ideBridgeChild) ideBridgeChild.kill('SIGTERM');
  ideBridgeChild = null;
  setTimeout(() => process.exit(0), 100).unref();
}
