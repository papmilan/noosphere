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
  const existing = registry.projects.find(
    (project) => project.path === normalized,
  );
  if (existing) {
    const unchanged =
      existing.project_id === projectId && existing.enabled === true;
    existing.project_id = projectId;
    existing.enabled = true;
    const lastActivation = Date.parse(existing.last_activated_at || 0);
    if (unchanged && Date.now() - lastActivation < 60_000) return registry;
    existing.last_activated_at = now;
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
