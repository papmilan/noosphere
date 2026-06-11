#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readRegistry } from './registry.js';

const directory = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(directory, '..', 'continuity', 'index.js');
const children = new Map();
const pollMs = Number(process.env.NOOSPHERE_MANAGER_POLL_MS || 5_000);
let stopping = false;

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
    }
  }

  for (const project of enabled.values()) {
    if (children.has(project.path)) continue;
    if (!(await exists(project.path))) continue;
    startWatcher(project);
  }
}

function startWatcher(project) {
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
    if (!stopping && code !== 0) {
      console.error(
        `[manager] Watcher exited for ${project.path} (${signal || code})`,
      );
    }
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
  setTimeout(() => process.exit(0), 100).unref();
}
