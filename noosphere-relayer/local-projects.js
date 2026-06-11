import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const directory = path.dirname(fileURLToPath(import.meta.url));

export function localProjectControl(config) {
  return (req, res, next) => {
    if (
      !isLoopbackHost(config.host) ||
      !isLoopbackAddress(req.socket.remoteAddress)
    ) {
      res.status(404).json({
        success: false,
        error: 'Local project control is only available on this computer',
      });
      return;
    }
    next();
  };
}

export async function listLocalProjects(env = process.env) {
  const { stdout } = await runContinuity(['projects'], env);
  const projects = JSON.parse(stdout || '[]');
  return Array.isArray(projects) ? projects : [];
}

export async function registerLocalProject(projectPath, env = process.env) {
  if (typeof projectPath !== 'string' || projectPath.trim() === '') {
    throw localProjectError('path must be a non-empty string', 400);
  }
  if (projectPath.length > 4_096) {
    throw localProjectError('path is too long', 400);
  }

  const enteredPath = projectPath.trim();
  const expandedPath =
    enteredPath === '~' || enteredPath.startsWith(`~${path.sep}`)
      ? path.join(os.homedir(), enteredPath.slice(2))
      : enteredPath;
  const resolvedPath = path.resolve(expandedPath);
  const resolved = await realpath(resolvedPath).catch(() => resolvedPath);
  try {
    const { stdout } = await runContinuity(
      ['register', '--path', resolved],
      env,
    );
    const projects = await listLocalProjects(env);
    const project = projects.find((entry) => entry.path === resolved) ||
      projects.find((entry) => entry.path === path.normalize(resolved));

    return {
      project: project || { path: resolved },
      message: stdout.trim() || `Project registered: ${resolved}`,
    };
  } catch (error) {
    const message =
      error.stderr?.trim() ||
      error.stdout?.trim() ||
      error.message ||
      'Could not register project';
    throw localProjectError(
      message.replace(/^Noosphere continuity:\\s*/i, ''),
      400,
    );
  }
}

export async function pauseLocalProject(projectId, env = process.env) {
  if (!projectId) throw localProjectError('projectId required', 400);
  try {
    await runContinuity(['pause', projectId], env);
    return { success: true };
  } catch (error) {
    throw continuityError(error, 'Could not pause project');
  }
}

export async function resumeLocalProject(projectId, env = process.env) {
  if (!projectId) throw localProjectError('projectId required', 400);
  try {
    await runContinuity(['resume', projectId], env);
    return { success: true };
  } catch (error) {
    throw continuityError(error, 'Could not resume project');
  }
}

export async function forgetLocalProject(projectId, env = process.env) {
  if (!projectId) throw localProjectError('projectId required', 400);
  try {
    await runContinuity(['forget', projectId], env);
    return { success: true };
  } catch (error) {
    throw continuityError(error, 'Could not forget project');
  }
}

async function runContinuity(args, env) {
  const cli =
    env.NOOSPHERE_CLI_PATH ||
    path.resolve(directory, '..', 'noosphere-mcp', 'continuity', 'index.js');
  return execFileAsync(process.execPath, [cli, ...args], {
    env,
    timeout: 30_000,
    maxBuffer: 2_000_000,
  });
}

function isLoopbackHost(host) {
  return ['127.0.0.1', '::1', 'localhost'].includes(host);
}

function isLoopbackAddress(address = '') {
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address.startsWith('127.') ||
    address === '::ffff:127.0.0.1'
  );
}

function localProjectError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function continuityError(error, fallback) {
  const message =
    error.stderr?.trim() ||
    error.stdout?.trim() ||
    error.message ||
    fallback;
  const cleaned = message.replace(/^Noosphere continuity:\s*/i, '');
  const status = /not found/i.test(cleaned) ? 404 : 500;
  return localProjectError(cleaned, status);
}
