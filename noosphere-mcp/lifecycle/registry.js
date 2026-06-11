import {
  mkdir,
  realpath,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function noosphereHome(env = process.env) {
  return path.resolve(
    env.NOOSPHERE_HOME || path.join(os.homedir(), '.noosphere'),
  );
}

export function registryPath(env = process.env) {
  return path.join(noosphereHome(env), 'projects.json');
}

export async function readRegistry(env = process.env) {
  try {
    const parsed = JSON.parse(await readFile(registryPath(env), 'utf8'));
    return {
      version: 1,
      projects: Array.isArray(parsed.projects) ? parsed.projects : [],
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, projects: [] };
    throw error;
  }
}

export async function registerProject(root, projectId, env = process.env) {
  const registry = await readRegistry(env);
  const normalized = await canonicalPath(root);
  const now = new Date().toISOString();

  const existingById = registry.projects.find(
    (project) => project.project_id === projectId,
  );
  const existingByPath = registry.projects.find(
    (project) => project.path === normalized,
  );

  if (existingById && existingById.path !== normalized) {
    registry.projects = registry.projects.filter(
      (project) =>
        project === existingById || project.path !== normalized,
    );
    existingById.path = normalized;
    existingById.enabled = true;
    existingById.last_activated_at = now;
  } else if (existingByPath) {
    const unchanged =
      existingByPath.project_id === projectId && existingByPath.enabled === true;
    existingByPath.project_id = projectId;
    existingByPath.enabled = true;
    const lastActivation = Date.parse(existingByPath.last_activated_at || 0);
    if (unchanged && Date.now() - lastActivation < 60_000) return registry;
    existingByPath.last_activated_at = now;
  } else {
    registry.projects.push({
      path: normalized,
      project_id: projectId,
      enabled: true,
      registered_at: now,
      last_activated_at: now,
    });
  }
  await writeRegistry(registry, env);
  return registry;
}

export async function pauseProject(projectId, env = process.env) {
  const registry = await readRegistry(env);
  const project = requireProject(registry, projectId);
  if (project.enabled !== false) {
    project.enabled = false;
    await writeRegistry(registry, env);
  }
  return registry;
}

export async function resumeProject(projectId, env = process.env) {
  const registry = await readRegistry(env);
  const project = requireProject(registry, projectId);
  if (project.enabled !== true) {
    project.enabled = true;
    project.last_activated_at = new Date().toISOString();
    await writeRegistry(registry, env);
  }
  return registry;
}

export async function forgetProject(projectId, env = process.env) {
  const registry = await readRegistry(env);
  requireProject(registry, projectId);
  registry.projects = registry.projects.filter(
    (project) => project.project_id !== projectId,
  );
  await writeRegistry(registry, env);
  return registry;
}

export async function disableProject(root, env = process.env) {
  const registry = await readRegistry(env);
  const normalized = await canonicalPath(root);
  const remaining = registry.projects.filter(
    (project) => project.path !== normalized,
  );
  if (remaining.length !== registry.projects.length) {
    registry.projects = remaining;
    await writeRegistry(registry, env);
  }
  return registry;
}

function requireProject(registry, projectId) {
  if (typeof projectId !== 'string' || projectId.trim() === '') {
    throw projectError('project_id is required', 400);
  }
  const project = registry.projects.find(
    (entry) => entry.project_id === projectId,
  );
  if (!project) {
    throw projectError(`Project not found: ${projectId}`, 404);
  }
  return project;
}

function projectError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function canonicalPath(value) {
  const resolved = path.resolve(value);
  return realpath(resolved).catch(() => resolved);
}

export async function writeRegistry(registry, env = process.env) {
  const file = registryPath(env);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify(registry, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  await rename(temporary, file);
}
