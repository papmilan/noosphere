#!/usr/bin/env node

import { spawn } from 'node:child_process';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, '..');

const TARGETS = Object.freeze({
  'remote-mcp': Object.freeze({
    defaultTag: 'noosphere-remote-mcp-server:latest',
    dockerignore: '.dockerignore',
    dockerfile: path.join('noosphere-remote-mcp-server', 'Dockerfile'),
    packages: Object.freeze([
      'noosphere-remote-mcp',
      'noosphere-remote-mcp-postgres',
      'noosphere-remote-mcp-server',
    ]),
  }),
  relayer: Object.freeze({
    defaultTag: 'noosphere-relayer:latest',
    dockerignore: path.join('noosphere-relayer', 'Dockerfile.dockerignore'),
    dockerfile: path.join('noosphere-relayer', 'Dockerfile'),
    packages: Object.freeze([
      'noosphere-relayer',
      'noosphere-secure-fs',
    ]),
  }),
});

const EXCLUDED_NAMES = new Set([
  '.DS_Store',
  '.cache',
  '.claude',
  '.claude-flow',
  '.cursor',
  '.git',
  '.noosphere',
  '.noosphere-local-memory.json',
  '.noosphere-runtime',
  '.serena',
  'coverage',
  'node_modules',
  'npm-debug.log',
  'tests',
]);

function contextError(code, message, cause) {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

function containedBy(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function excluded(name) {
  return name.startsWith('._')
    || name === '.env'
    || name.startsWith('.env.')
    || EXCLUDED_NAMES.has(name);
}

async function copyContextEntry(source, destination) {
  const info = await lstat(source).catch((cause) => {
    throw contextError('docker-context-source-missing', `missing Docker context source: ${source}`, cause);
  });
  if (info.isSymbolicLink()) {
    throw contextError('docker-context-symlink', `refusing symlink in Docker context: ${source}`);
  }
  if (info.isDirectory()) {
    await mkdir(destination, { mode: info.mode & 0o777 });
    const entries = await readdir(source, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      // Decide from the directory entry name before touching the inode. This is
      // what avoids BuildKit's external-volume failure: unreadable `._*`
      // AppleDouble metadata never reaches lstat, xattr, or the staged context.
      if (excluded(entry.name)) continue;
      await copyContextEntry(
        path.join(source, entry.name),
        path.join(destination, entry.name),
      );
    }
    return;
  }
  if (!info.isFile()) {
    throw contextError('docker-context-nonregular', `refusing non-regular Docker context entry: ${source}`);
  }
  await copyFile(source, destination);
  await chmod(destination, info.mode & 0o777);
}

export async function stageDockerBuildContext({
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  destination,
  target,
}) {
  const configuration = TARGETS[target];
  if (!configuration) {
    throw contextError(
      'docker-context-target',
      `unknown Docker target ${JSON.stringify(target)}; expected remote-mcp or relayer`,
    );
  }
  if (typeof destination !== 'string' || destination.trim() === '') {
    throw contextError('docker-context-destination', 'a non-empty Docker context destination is required');
  }
  const root = path.resolve(repositoryRoot);
  const staged = path.resolve(destination);
  if (containedBy(root, staged)) {
    throw contextError(
      'docker-context-destination',
      'the staged Docker context must be outside the repository',
    );
  }
  const existing = await lstat(staged).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing !== null) {
    throw contextError('docker-context-destination-exists', `Docker context destination already exists: ${staged}`);
  }

  await mkdir(staged, { mode: 0o700 });
  try {
    await copyContextEntry(
      path.join(root, configuration.dockerignore),
      path.join(staged, '.dockerignore'),
    );
    for (const packageName of configuration.packages) {
      await copyContextEntry(path.join(root, packageName), path.join(staged, packageName));
    }

    const dockerfile = path.join(staged, configuration.dockerfile);
    const dockerfileInfo = await lstat(dockerfile).catch((cause) => {
      throw contextError('docker-context-dockerfile', `staged Dockerfile is missing: ${dockerfile}`, cause);
    });
    if (!dockerfileInfo.isFile() || dockerfileInfo.isSymbolicLink()) {
      throw contextError('docker-context-dockerfile', `staged Dockerfile is not a regular file: ${dockerfile}`);
    }
    return Object.freeze({
      defaultTag: configuration.defaultTag,
      destination: staged,
      dockerfile: configuration.dockerfile,
    });
  } catch (error) {
    await rm(staged, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

export async function buildDockerImage({
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  target,
  tag,
  dockerCommand = 'docker',
}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'noosphere-docker-build-'));
  // stageDockerBuildContext refuses an existing destination, so reserve a
  // sibling path rather than the directory mkdtemp itself created.
  const staged = `${temporary}-context`;
  try {
    const context = await stageDockerBuildContext({ repositoryRoot, destination: staged, target });
    const imageTag = tag ?? context.defaultTag;
    if (typeof imageTag !== 'string' || imageTag.trim() === '') {
      throw contextError('docker-build-tag', 'the Docker image tag must be a non-empty string');
    }
    const child = spawn(dockerCommand, [
      'build',
      '-f',
      context.dockerfile,
      '-t',
      imageTag,
      '.',
    ], {
      cwd: context.destination,
      stdio: 'inherit',
      windowsHide: true,
    });
    const result = await waitForChild(child);
    if (result.code !== 0) {
      throw contextError(
        'docker-build-failed',
        `Docker build failed${result.signal ? ` with ${result.signal}` : ` with exit ${result.code}`}`,
      );
    }
    return Object.freeze({ imageTag, target });
  } finally {
    await rm(staged, { recursive: true, force: true }).catch(() => undefined);
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
}

function usage() {
  return [
    'Usage: node scripts/docker-build.mjs <remote-mcp|relayer> [--tag <image:tag>]',
    '',
    'Stages a metadata-free temporary context, builds with Docker, then removes it.',
  ].join('\n');
}

function parseArguments(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const [target, ...rest] = argv;
  if (!TARGETS[target]) throw contextError('docker-build-usage', usage());
  let tag;
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] !== '--tag' || tag !== undefined || index + 1 >= rest.length) {
      throw contextError('docker-build-usage', usage());
    }
    tag = rest[index + 1];
    index += 1;
  }
  return { help: false, tag, target };
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await buildDockerImage(parsed);
  process.stdout.write(`Built ${result.imageTag} from a sanitized ${result.target} context.\n`);
}

const invoked = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;
if (invoked) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.code === 'docker-build-usage' ? 2 : 1;
  });
}
