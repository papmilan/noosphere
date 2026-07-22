import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const IS_WINDOWS = process.platform === 'win32';

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

// Single containment traversal, shared by readers and writers. Walks every segment
// from `root` down to `dir`, rejecting any symlinked or non-directory component and
// verifying realpath containment at each level. With `create`, missing components
// are made as real directories (write path); without it, a missing component means
// the subtree does not exist and null is returned (read path) — reads never mutate.
async function walkContained(root, dir, { create, mode = 0o700 }) {
  const rootReal = await realpath(root);
  let current = root;
  for (const segment of relativeSegments(root, dir)) {
    current = path.join(current, segment);
    let info = await lstat(current).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info === null) {
      if (!create) return null;
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

export async function ensureContainedDir(root, dir, { mode = 0o700 } = {}) {
  return walkContained(root, dir, { create: true, mode });
}

// Non-creating twin of ensureContainedDir: validates the FULL chain from root to
// dir without creating anything. Returns the validated dir, or null if the chain
// does not fully exist (so a reader treats the target as absent). This is what makes
// the read boundary semantically identical to the write boundary.
export async function assertContainedChain(root, dir) {
  return walkContained(root, dir, { create: false });
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

function walkContainedSync(root, dir, { create, mode = 0o700 }) {
  const rootReal = fs.realpathSync(root);
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
      if (!create) return null;
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
    assertContained(rootReal, fs.realpathSync(current));
  }
  return current;
}

export function ensureContainedDirSync(root, dir, { mode = 0o700 } = {}) {
  return walkContainedSync(root, dir, { create: true, mode });
}

export function assertContainedChainSync(root, dir) {
  return walkContainedSync(root, dir, { create: false });
}

// SEC-03 (Windows): O_NOFOLLOW is unavailable on Windows (NOFOLLOW === 0), so the
// no-follow open below is a no-op there and a final-component symlink or junction
// would be followed. When the flag is absent, reject a reparse final component with
// an explicit lstat pre-check instead. On POSIX the O_NOFOLLOW open is authoritative
// and this extra syscall is skipped, so POSIX behavior is unchanged.
// Residual (Windows only): a lstat->open TOCTOU window, the same class as the POSIX
// openat/TOCTOU residual; a file cannot be a junction/mount reparse point (only a
// dir can), and directory reparse points are already rejected by the ancestor walk.
function assertFinalNotReparse(file) {
  if (NOFOLLOW !== 0) return;
  let info;
  try {
    info = fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (info.isSymbolicLink()) {
    throw new PathBoundaryError('state-file-symlink', `refusing symlinked file: ${file}`);
  }
}

// Writes a file, refusing to follow a final symlink. Truncates an existing regular
// file (state stores overwrite their own files), but ELOOP if the path is a symlink.
export function writeFileNoFollowSync(file, data, mode = 0o600) {
  assertFinalNotReparse(file);
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
  // SEC-03 (Windows): 0o600 is not owner-only on Windows; lock the ACL down.
  secureOwnerOnlyWindows(file);
}

// SEC-03 (Windows owner-only): Node's 0o600 mode is NOT an owner-only ACL on
// Windows — a persisted secret/state file can inherit broad read ACEs (Everyone /
// BUILTIN\Users / Authenticated Users), letting another local account read it. Apply
// an explicit owner-only ACL with icacls: strip inheritance and grant Full only to
// the current user, SYSTEM, and Administrators. Arguments are passed as an argv array
// (execFileSync, no shell), so the path is never interpolated into a command line.
// Fails closed (state-acl-failed) and verifies the effective ACL grants no broad
// principal (state-acl-broad). No-op on POSIX, where 0o600 is authoritative.
const BROAD_PRINCIPAL = /(^|\s)(Everyone|BUILTIN\\Users|(NT AUTHORITY\\)?Authenticated Users):/i;
let cachedWindowsPrincipal;
function currentWindowsPrincipal() {
  if (cachedWindowsPrincipal) return cachedWindowsPrincipal;
  try {
    cachedWindowsPrincipal = execFileSync('whoami', [], { encoding: 'utf8' }).trim();
  } catch {
    const domain = process.env.USERDOMAIN || process.env.COMPUTERNAME || '';
    const user = process.env.USERNAME || '';
    cachedWindowsPrincipal = domain && user ? `${domain}\\${user}` : user;
  }
  if (!cachedWindowsPrincipal) {
    throw new PathBoundaryError('state-acl-failed', 'could not resolve current Windows principal for owner-only ACL');
  }
  return cachedWindowsPrincipal;
}

export function secureOwnerOnlyWindows(file) {
  if (!IS_WINDOWS) return;
  const user = currentWindowsPrincipal();
  try {
    execFileSync('icacls', [
      file,
      // Strip INHERITED ACEs, then explicitly REMOVE any broad principal's own ACE
      // (/inheritance:r alone does not remove an explicit Everyone/Users grant), then
      // grant Full only to the owner, SYSTEM, and Administrators.
      '/inheritance:r',
      '/remove:g', 'Everyone',
      '/remove:g', 'BUILTIN\\Users',
      '/remove:g', 'Authenticated Users',
      '/grant:r', `${user}:(F)`,
      '/grant:r', 'SYSTEM:(F)',
      '/grant:r', 'BUILTIN\\Administrators:(F)',
    ], { stdio: 'pipe' });
  } catch (error) {
    throw new PathBoundaryError('state-acl-failed', `could not apply owner-only ACL to ${file}: ${error.message}`);
  }
  let acl;
  try {
    acl = execFileSync('icacls', [file], { encoding: 'utf8' });
  } catch (error) {
    throw new PathBoundaryError('state-acl-failed', `could not read back ACL for ${file}: ${error.message}`);
  }
  if (BROAD_PRINCIPAL.test(acl)) {
    throw new PathBoundaryError('state-acl-broad', `owner-only ACL not effective for ${file}`);
  }
}

export function readFileNoFollowSync(file) {
  assertFinalNotReparse(file);
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

// SEC-03: read a state-store file through the SAME trust boundary its writer uses.
// The writer (ensureRealDirectoryPath -> ensureContainedDir) validates the whole
// ancestor chain from the trusted root; this reader mirrors it exactly via
// assertContainedChain (non-creating), so a symlinked ANY-level ancestor is rejected
// (state-dir-symlink), not just the immediate parent. The final component is then
// opened with O_NOFOLLOW (state-file-symlink). Returns the file contents (utf8) or
// null when the directory chain or file is absent, so a fresh store starts empty.
// Never creates directories — load is a read, not a write.
export async function readContainedStateFile(file) {
  const { root, dir } = trustedRootFor(path.dirname(file));
  if (await assertContainedChain(root, dir) === null) return null;
  return readFileNoFollowSync(file);
}
