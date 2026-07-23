import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const WINDOWS_SCRIPT = fileURLToPath(new URL('./windows-owner-only.ps1', import.meta.url));

export class PathBoundaryError extends Error {
  constructor(code, message, cause) {
    super(message ?? code, cause === undefined ? undefined : { cause });
    this.code = code;
    this.name = 'PathBoundaryError';
  }
}

function relativeSegments(root, dir) {
  const relative = path.relative(root, dir);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new PathBoundaryError('state-dir-escape', `${dir} is not under ${root}`);
  }
  return relative === '' ? [] : relative.split(path.sep);
}

function assertContained(rootReal, candidateReal) {
  const relative = path.relative(rootReal, candidateReal);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new PathBoundaryError('state-dir-escape', `resolved ${candidateReal} escapes ${rootReal}`);
  }
}

export async function ensureContainedDir(root, dir, { mode = 0o700 } = {}) {
  return walkContained(root, dir, { create: true, mode });
}

export async function assertContainedChain(root, dir) {
  return walkContained(root, dir, { create: false });
}

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

export function ensureContainedDirSync(root, dir, { mode = 0o700 } = {}) {
  return walkContainedSync(root, dir, { create: true, mode });
}

export function assertContainedChainSync(root, dir) {
  return walkContainedSync(root, dir, { create: false });
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

export async function ensureRealDirectoryPath(dir, { mode = 0o700 } = {}) {
  const { root, dir: absolute } = trustedRootFor(dir);
  return ensureContainedDir(root, absolute, { mode });
}

function trustedRootFor(dir) {
  const absolute = path.resolve(dir);
  const candidates = [os.homedir(), os.tmpdir()]
    .filter(Boolean)
    .map((candidate) => path.resolve(candidate))
    .filter((candidate) => {
      const relative = path.relative(candidate, absolute);
      return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    })
    .sort((left, right) => right.length - left.length);
  return { root: candidates[0] ?? path.parse(absolute).root, dir: absolute };
}

function assertFinalNotReparseSync(file) {
  let info;
  try {
    info = fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (info.isSymbolicLink()) {
    throw new PathBoundaryError('state-file-symlink', `refusing symlinked file: ${file}`);
  }
  if (!info.isFile()) {
    throw new PathBoundaryError('state-file-not-regular', `refusing non-regular file: ${file}`);
  }
  return info;
}

async function assertFinalNotReparse(file) {
  const info = await lstat(file).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (info?.isSymbolicLink()) {
    throw new PathBoundaryError('state-file-symlink', `refusing symlinked file: ${file}`);
  }
  if (info && !info.isFile()) {
    throw new PathBoundaryError('state-file-not-regular', `refusing non-regular file: ${file}`);
  }
  return info;
}

function buffer(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
}

function rootAndDirectory(file, root) {
  const absolute = path.resolve(file);
  return {
    file: absolute,
    root: root ? path.resolve(root) : trustedRootFor(path.dirname(absolute)).root,
    directory: path.dirname(absolute),
  };
}

export async function atomicOwnerOnlyWrite(file, data, options = {}) {
  const resolved = rootAndDirectory(file, options.root);
  await ensureContainedDir(resolved.root, resolved.directory, { mode: options.directoryMode ?? 0o700 });
  await assertFinalNotReparse(resolved.file);
  const temporary = path.join(resolved.directory, `.${path.basename(resolved.file)}.${randomUUID()}.tmp`);
  try {
    await writeOwnerOnlyFileExclusive(temporary, data, { ...options, root: resolved.root });
    await assertFinalNotReparse(resolved.file);
    await (options.rename ?? rename)(temporary, resolved.file);
  } catch (error) {
    await safeCleanup(temporary);
    throw normalizeSecurityError(error);
  }
}

export function atomicOwnerOnlyWriteSync(file, data, options = {}) {
  const resolved = rootAndDirectory(file, options.root);
  ensureContainedDirSync(resolved.root, resolved.directory, { mode: options.directoryMode ?? 0o700 });
  assertFinalNotReparseSync(resolved.file);
  const temporary = path.join(resolved.directory, `.${path.basename(resolved.file)}.${randomUUID()}.tmp`);
  try {
    writeOwnerOnlyFileExclusiveSync(temporary, data, { ...options, root: resolved.root });
    assertFinalNotReparseSync(resolved.file);
    (options.rename ?? fs.renameSync)(temporary, resolved.file);
  } catch (error) {
    safeCleanupSync(temporary);
    throw normalizeSecurityError(error);
  }
}

export async function writeOwnerOnlyFileExclusive(file, data, options = {}) {
  const resolved = rootAndDirectory(file, options.root);
  await ensureContainedDir(resolved.root, resolved.directory, { mode: options.directoryMode ?? 0o700 });
  if (await assertFinalNotReparse(resolved.file)) {
    throw new PathBoundaryError('state-file-exists', `refusing to replace an existing staged file: ${resolved.file}`);
  }
  const bytes = buffer(data);
  try {
    if ((options.platform ?? process.platform) === 'win32') {
      await Promise.resolve((options.windowsAction ?? defaultWindowsAction)({
        action: 'write', file: resolved.file, input: bytes,
      }));
      const info = await assertFinalNotReparse(resolved.file);
      if (!info || info.size !== bytes.length) {
        throw new PathBoundaryError('state-write-incomplete', `secure writer produced an incomplete file: ${resolved.file}`);
      }
    } else {
      await writePosixTemporary(resolved.file, bytes, options.mode ?? 0o600);
    }
  } catch (error) {
    if (error.code !== 'state-file-exists' && error.code !== 'EEXIST') await safeCleanup(resolved.file);
    if (error.code === 'EEXIST') {
      throw new PathBoundaryError('state-file-exists', `refusing to replace an existing staged file: ${resolved.file}`, error);
    }
    throw normalizeSecurityError(error);
  }
}

export function writeOwnerOnlyFileExclusiveSync(file, data, options = {}) {
  const resolved = rootAndDirectory(file, options.root);
  ensureContainedDirSync(resolved.root, resolved.directory, { mode: options.directoryMode ?? 0o700 });
  if (assertFinalNotReparseSync(resolved.file)) {
    throw new PathBoundaryError('state-file-exists', `refusing to replace an existing staged file: ${resolved.file}`);
  }
  const bytes = buffer(data);
  try {
    if ((options.platform ?? process.platform) === 'win32') {
      (options.windowsAction ?? defaultWindowsAction)({ action: 'write', file: resolved.file, input: bytes });
      const info = assertFinalNotReparseSync(resolved.file);
      if (!info || info.size !== bytes.length) {
        throw new PathBoundaryError('state-write-incomplete', `secure writer produced an incomplete file: ${resolved.file}`);
      }
    } else {
      writePosixTemporarySync(resolved.file, bytes, options.mode ?? 0o600);
    }
  } catch (error) {
    if (error.code !== 'state-file-exists' && error.code !== 'EEXIST') safeCleanupSync(resolved.file);
    if (error.code === 'EEXIST') {
      throw new PathBoundaryError('state-file-exists', `refusing to replace an existing staged file: ${resolved.file}`, error);
    }
    throw normalizeSecurityError(error);
  }
}

async function writePosixTemporary(file, bytes, mode) {
  let handle;
  try {
    handle = await open(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | NOFOLLOW, mode);
    await handle.chmod(mode);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    if (error.code === 'ELOOP') throw new PathBoundaryError('state-file-symlink', `refusing symlinked file: ${file}`, error);
    throw error;
  } finally {
    await handle?.close();
  }
}

function writePosixTemporarySync(file, bytes, mode) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | NOFOLLOW, mode);
    fs.fchmodSync(fd, mode);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } catch (error) {
    if (error.code === 'ELOOP') throw new PathBoundaryError('state-file-symlink', `refusing symlinked file: ${file}`, error);
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export async function readOwnerOnlyFile(file, options = {}) {
  const resolved = rootAndDirectory(file, options.root);
  if (await assertContainedChain(resolved.root, resolved.directory) === null) return null;
  if (await assertFinalNotReparse(resolved.file) === null) return null;
  if ((options.platform ?? process.platform) === 'win32') {
    return buffer(await Promise.resolve((options.windowsAction ?? defaultWindowsAction)({
      action: 'read', file: resolved.file, input: null,
    })));
  }
  return readNoFollow(resolved.file);
}

export function readOwnerOnlyFileSync(file, options = {}) {
  const resolved = rootAndDirectory(file, options.root);
  if (assertContainedChainSync(resolved.root, resolved.directory) === null) return null;
  if (assertFinalNotReparseSync(resolved.file) === null) return null;
  if ((options.platform ?? process.platform) === 'win32') {
    return buffer((options.windowsAction ?? defaultWindowsAction)({ action: 'read', file: resolved.file, input: null }));
  }
  return readNoFollowSync(resolved.file);
}

async function readNoFollow(file) {
  let handle;
  try {
    handle = await open(file, fs.constants.O_RDONLY | NOFOLLOW);
    return await handle.readFile();
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code === 'ELOOP') throw new PathBoundaryError('state-file-symlink', `refusing symlinked file: ${file}`, error);
    throw error;
  } finally {
    await handle?.close();
  }
}

function readNoFollowSync(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
    return fs.readFileSync(fd);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code === 'ELOOP') throw new PathBoundaryError('state-file-symlink', `refusing symlinked file: ${file}`, error);
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function secureOwnerOnlyWindows(file, options = {}) {
  if ((options.platform ?? process.platform) !== 'win32') return;
  assertFinalNotReparseSync(file);
  (options.windowsAction ?? defaultWindowsAction)({ action: 'repair', file: path.resolve(file), input: null });
}

export function currentWindowsSid(options = {}) {
  if ((options.platform ?? process.platform) !== 'win32') return null;
  const output = (options.windowsAction ?? defaultWindowsAction)({ action: 'sid', file: '', input: null });
  const sid = buffer(output).toString('utf8').trim();
  if (!/^S-1-(?:\d+-)+\d+$/.test(sid)) {
    throw new PathBoundaryError('state-acl-sid-failed', 'Windows token SID resolution returned an invalid SID');
  }
  return sid;
}

export function verifyOwnerOnlyWindows(file, options = {}) {
  if ((options.platform ?? process.platform) !== 'win32') return [];
  assertFinalNotReparseSync(file);
  const output = (options.windowsAction ?? defaultWindowsAction)({
    action: 'verify', file: path.resolve(file), input: null,
  });
  const sids = buffer(output).toString('utf8').split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const uniqueSids = [...new Set(sids)].sort();
  if (
    uniqueSids.length < 2
    || uniqueSids.length > 3
    || uniqueSids.some((sid) => !/^S-1-(?:\d+-)+\d+$/.test(sid))
    || !uniqueSids.includes('S-1-5-18')
    || !uniqueSids.includes('S-1-5-32-544')
  ) {
    throw new PathBoundaryError('state-acl-readback-failed', 'Windows DACL verification returned an invalid SID set');
  }
  return uniqueSids;
}

export function writeFileNoFollowSync(file, data, mode = 0o600, options = {}) {
  return atomicOwnerOnlyWriteSync(file, data, { ...options, mode });
}

export function readFileNoFollowSync(file, options = {}) {
  const result = readOwnerOnlyFileSync(file, options);
  return result === null ? null : result.toString('utf8');
}

export async function readContainedStateFile(file, options = {}) {
  const result = await readOwnerOnlyFile(file, options);
  return result === null ? null : result.toString('utf8');
}

function defaultWindowsAction({ action, file, input }) {
  try {
    return execFileSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', WINDOWS_SCRIPT, action, file,
    ], {
      input: input ?? undefined,
      encoding: 'buffer',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const stderr = Buffer.isBuffer(error.stderr) ? error.stderr.toString('utf8') : String(error.stderr ?? '');
    const match = stderr.match(/NOOSPHERE_ACL_ERROR:([a-z0-9-]+):([^\r\n]*)/i);
    const code = match?.[1] ?? 'state-acl-failed';
    const message = match?.[2] || error.message;
    throw new PathBoundaryError(code, message, error);
  }
}

function normalizeSecurityError(error) {
  if (error instanceof PathBoundaryError) return error;
  return error;
}

async function safeCleanup(file) {
  await rm(file, { force: true }).catch(() => undefined);
}

function safeCleanupSync(file) {
  try { fs.rmSync(file, { force: true }); } catch { /* best effort after failed write */ }
}
