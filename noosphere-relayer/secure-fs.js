import fs from 'node:fs';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Centralized filesystem trust boundary. A cloned repository (or a local attacker)
// can pre-create a Noosphere state directory, credential file, or path component as
// a symlink so that writes/chmods land outside the intended tree. Every state store
// resolves its directory through ensureContainedDir before writing, which:
//   - refuses any symlinked path component under the project/home root,
//   - creates each missing component as a real directory (never following a link),
//   - and verifies realpath containment after creation.
// File creation additionally uses O_NOFOLLOW | O_EXCL where a store opens a file by
// name, so an individual state/credential file cannot be a symlink either.

export class PathBoundaryError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.code = code;
    this.name = 'PathBoundaryError';
  }
}

const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

function relativeSegments(root, dir) {
  const relative = path.relative(root, dir);
  if (
    relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new PathBoundaryError('state-dir-escape', `${dir} is not under ${root}`);
  }
  return relative === '' ? [] : relative.split(path.sep);
}

function assertContained(rootReal, dirReal) {
  const relative = path.relative(rootReal, dirReal);
  if (
    relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new PathBoundaryError('state-dir-escape', `resolved ${dirReal} escapes ${rootReal}`);
  }
}

function trustedRootFor(dir) {
  const absolute = path.resolve(dir);
  const candidates = [os.homedir(), os.tmpdir()]
    .filter(Boolean)
    .map((candidate) => path.resolve(candidate))
    .filter((candidate) => {
      const relative = path.relative(candidate, absolute);
      return relative === '' || (
        relative !== '..'
        && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative)
      );
    })
    .sort((left, right) => right.length - left.length);

  return {
    root: candidates[0] ?? path.parse(absolute).root,
    dir: absolute,
  };
}

export async function ensureContainedDir(root, dir, { mode = 0o700 } = {}) {
  const rootReal = await realpath(root);
  let current = root;
  for (const segment of relativeSegments(root, dir)) {
    current = path.join(current, segment);
    let info = await lstat(current).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info === null) {
      // Tolerate a concurrent creator: EEXIST just means we re-inspect below.
      await mkdir(current, { mode }).catch((error) => {
        if (error.code !== 'EEXIST') throw error;
      });
      info = await lstat(current);
    }
    if (info.isSymbolicLink()) {
      throw new PathBoundaryError('state-dir-symlink', `refusing symlinked path component: ${current}`);
    }
    if (!info.isDirectory()) {
      throw new PathBoundaryError('state-dir-not-directory', `not a directory: ${current}`);
    }
    assertContained(rootReal, await realpath(current));
  }
  return current;
}

export async function ensureRealDirectoryPath(dir, options = {}) {
  const boundary = trustedRootFor(dir);
  return ensureContainedDir(boundary.root, boundary.dir, options);
}

// Lightweight guard for stores whose file lives at a configured path with no
// enclosing project root: refuse to write into a directory that is itself a symlink.
export async function assertRealDirectory(dir) {
  const info = await lstat(dir).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (info?.isSymbolicLink()) {
    throw new PathBoundaryError('state-dir-symlink', `refusing symlinked directory: ${dir}`);
  }
  return info;
}

export function ensureContainedDirSync(root, dir, { mode = 0o700 } = {}) {
  let current = root;
  for (const segment of relativeSegments(root, dir)) {
    current = path.join(current, segment);
    let info = null;
    try {
      info = fs.lstatSync(current);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (info === null) {
      try {
        fs.mkdirSync(current, { mode });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      info = fs.lstatSync(current);
    }
    if (info.isSymbolicLink()) {
      throw new PathBoundaryError('state-dir-symlink', `refusing symlinked path component: ${current}`);
    }
    if (!info.isDirectory()) {
      throw new PathBoundaryError('state-dir-not-directory', `not a directory: ${current}`);
    }
  }
  assertContained(fs.realpathSync(root), fs.realpathSync(current));
  return current;
}

// Writes a file, refusing to follow a final symlink. Truncates an existing regular
// file (state stores overwrite their own files), but ELOOP if the path is a symlink.
export function writeFileNoFollowSync(file, data, mode = 0o600) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_WRONLY | NOFOLLOW, mode);
  } catch (error) {
    if (error.code === 'ELOOP') throw new PathBoundaryError('state-file-symlink', `refusing symlinked file: ${file}`);
    throw error;
  }
  try {
    fs.writeSync(fd, data);
    fs.fchmodSync(fd, mode);
  } finally {
    fs.closeSync(fd);
  }
}

export function readFileNoFollowSync(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    if (error.code === 'ELOOP') throw new PathBoundaryError('state-file-symlink', `refusing symlinked file: ${file}`);
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}
