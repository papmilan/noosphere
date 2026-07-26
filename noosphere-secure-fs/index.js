import { execFileSync } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
// O_NONBLOCK is what makes opening an unknown filesystem object safe. O_NOFOLLOW
// only refuses a symlinked final component; a FIFO opened O_RDONLY blocks in
// open(2) until a writer appears, which is indefinite and produces no error code
// — no amount of error classification recovers from it. With O_NONBLOCK the open
// returns immediately and fstat then decides what was actually opened.
const NONBLOCK = fs.constants.O_NONBLOCK || 0;
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
    if ((options.platform ?? process.platform) !== 'win32') await fsyncDir(resolved.directory);
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
    if ((options.platform ?? process.platform) !== 'win32') fsyncDirSync(resolved.directory);
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

// Strict RFC 4122 version-4 token. A loose hyphen-count regex would accept
// non-UUID material (e.g. 36 hyphens); the release owner-check must compare a
// well-formed token, so acquisition validates the exact v4 shape up front.
const LOCK_TOKEN_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// An owner-only, no-follow lock file. The exclusive create is the acquisition
// operation on every platform; Windows delegates CreateNew to the hardened
// PowerShell helper, so there is no check-then-create window. Callers attach
// authenticated metadata (the filesystem boundary deliberately has no access to
// application MAC keys). Release re-reads and constant-time verifies the token
// before deletion, preventing one transaction from removing another's lock.
export async function acquireOwnerOnlyLock(file, { token = randomUUID(), metadata = {}, ...options } = {}) {
  if (typeof token !== 'string' || !LOCK_TOKEN_V4.test(token)) {
    throw new PathBoundaryError('state-lock-token-invalid', 'lock token must be an RFC 4122 v4 UUID');
  }
  const payload = JSON.stringify({ ...metadata, token });
  try {
    await writeOwnerOnlyFileExclusive(file, payload, options);
  } catch (error) {
    if (error.code === 'state-file-exists' || error.code === 'EEXIST') {
      throw new PathBoundaryError('trust-lock-busy', 'an owner-only transaction lock is already held', error);
    }
    throw error;
  }
  let released = false;
  return Object.freeze({
    file,
    token,
    async release(candidateToken = token) {
      if (released) return;
      const raw = await readOwnerOnlyFile(file, options);
      if (raw === null) throw new PathBoundaryError('trust-lock-missing', 'transaction lock disappeared before release');
      let parsed;
      try { parsed = JSON.parse(raw.toString('utf8')); } catch {
        throw new PathBoundaryError('trust-lock-malformed', 'transaction lock metadata is malformed');
      }
      if (typeof parsed?.token !== 'string') {
        throw new PathBoundaryError('trust-lock-malformed', 'transaction lock has no token');
      }
      const expected = Buffer.from(parsed.token, 'utf8');
      const actual = Buffer.from(String(candidateToken), 'utf8');
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        throw new PathBoundaryError('trust-lock-not-owner', 'transaction lock token does not match');
      }
      await rm(file, { force: false });
      released = true;
    },
  });
}

// After an atomic rename the file bytes are already fsync'd (writePosixTemporary
// calls handle.sync()), but the *rename* itself — the directory entry — is only
// durable once the containing directory is fsync'd. Without this, a power loss
// can lose or revert a committed manifest (availability, never false authority:
// a missing/partial manifest fails closed). Best-effort: some filesystems reject
// directory fsync, and Windows uses the helper path where this does not apply.
// Some filesystems genuinely do not support fsync on a directory fd and report it
// with these errno. Those are safe to ignore (nothing to sync). Every other error
// — EIO, ENOSPC, EACCES, EBADF, EROFS, … — is a real durability failure and must
// NOT be swallowed silently, or a write would be reported durable when it is not.
const DIR_FSYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP']);

export function isIgnorableDirFsyncError(error) {
  return Boolean(error) && DIR_FSYNC_UNSUPPORTED.has(error.code);
}

// Surface a meaningful directory-fsync failure as a diagnostic without failing the
// write (the file bytes are already fsync'd and the rename already landed; only
// rename *durability confirmation* is in question). The message carries the errno
// only — never any path bytes, key, or MAC material. Availability, never authority.
function reportDirFsyncError(error) {
  if (isIgnorableDirFsyncError(error)) return;
  process.emitWarning(
    `directory fsync did not confirm rename durability (${error?.code ?? 'unknown'}); the write completed but survival across power loss is unconfirmed`,
    { code: 'NOOSPHERE_DIR_FSYNC' },
  );
}

async function fsyncDir(dir) {
  let handle;
  try { handle = await open(dir, 'r'); await handle.sync(); }
  catch (error) { reportDirFsyncError(error); }
  finally { await handle?.close().catch(() => undefined); }
}

function fsyncDirSync(dir) {
  let fd;
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); }
  catch (error) { reportDirFsyncError(error); }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } } }
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

// THE safe read for a file whose content, type, and size are controlled by
// something other than this process — a working tree, a git checkout, another
// tool. Every such read in the product funnels through here so the guarantees
// are one implementation rather than one-per-call-site:
//
//   O_NOFOLLOW   the final component is never followed; a symlinked target is
//                refused at the kernel, not after a racy lstat.
//   O_NONBLOCK   a FIFO, socket, or slow device opens immediately instead of
//                blocking forever with no error code to classify.
//   fstat(fd)    the object is judged AFTER it is opened, so a path swapped
//                between the decision and the open cannot change what is read.
//   size check   an oversized file is refused before a byte is allocated, so a
//                sparse 8 GiB file costs one fstat, not 8 GiB of memory.
//   bounded read at most maxBytes + 1 bytes are ever read, so growth after the
//                fstat is detected rather than silently truncated.
//
// Returns a Buffer, or null when the file does not exist. Callers map the
// PathBoundaryError codes onto their own vocabulary.
//
// Residual, Windows only: O_NOFOLLOW and O_NONBLOCK do not exist there, so the
// no-follow guarantee degrades to a pre-open lstat and keeps a small TOCTOU
// window between that lstat and the open. Maximum impact is reading the content
// of a file the tree writer redirected to — it cannot make that content
// authoritative (authority is bound to exact approved bytes, and approval is a
// separate interactive transition), and it cannot exceed the size bound, which
// is enforced on the opened descriptor. POSIX has no such window.
export async function readBoundedRegularFile(file, { maxBytes } = {}) {
  const limit = boundedReadLimit(maxBytes);
  const absolute = path.resolve(file);
  if (process.platform === 'win32') {
    const info = await lstat(absolute).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info === null) return null;
    // Classifies or throws; it has no "absent" answer, because absence was
    // already decided by the lstat above.
    windowsPreOpen(info, absolute, limit);
  }
  let handle;
  try {
    handle = await open(absolute, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw boundedOpenError(error, absolute);
  }
  try {
    const info = await handle.stat();
    if (process.platform === 'win32') {
      const after = await lstat(absolute).catch(() => null);
      assertWindowsIdentityUnchanged(info, after, absolute);
    }
    return await readWithinBound(info, handle, absolute, limit);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export function readBoundedRegularFileSync(file, { maxBytes } = {}) {
  const limit = boundedReadLimit(maxBytes);
  const absolute = path.resolve(file);
  if (process.platform === 'win32') {
    let info = null;
    try {
      info = fs.lstatSync(absolute);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (info === null) return null;
    windowsPreOpen(info, absolute, limit);
  }
  let fd;
  try {
    fd = fs.openSync(absolute, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw boundedOpenError(error, absolute);
  }
  try {
    const info = fs.fstatSync(fd);
    if (process.platform === 'win32') {
      let after = null;
      try { after = fs.lstatSync(absolute); } catch { after = null; }
      assertWindowsIdentityUnchanged(info, after, absolute);
    }
    assertBoundedRegular(info, absolute, limit);
    const bytes = Buffer.allocUnsafe(Math.min(info.size, limit) + 1);
    let read = 0;
    let chunk = 0;
    do {
      chunk = fs.readSync(fd, bytes, read, bytes.length - read, read);
      read += chunk;
    } while (chunk > 0 && read < bytes.length);
    return finishBoundedRead(bytes, read, info, absolute, limit);
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
}

function boundedReadLimit(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new PathBoundaryError('state-read-bound-invalid', 'a bounded read requires a non-negative integer maxBytes');
  }
  return maxBytes;
}

// ELOOP is what O_NOFOLLOW reports for a symlinked final component (and what the
// kernel reports for a symlink loop in a path component). ENXIO is a FIFO opened
// O_NONBLOCK with nothing on the other end — a non-regular object either way.
// Everything else propagates unchanged: an unrecognised errno is a real fault and
// must stay visible rather than be folded into a friendly refusal.
function boundedOpenError(error, file) {
  if (error.code === 'ELOOP') return new PathBoundaryError('state-file-symlink', `refusing symlinked file: ${file}`, error);
  if (error.code === 'ENXIO') return new PathBoundaryError('state-file-not-regular', `refusing non-regular file: ${file}`, error);
  return error;
}

// Windows has no O_NOFOLLOW and no O_NONBLOCK (`fs.constants` reports both as
// 0), so the no-follow decision has to be made before the open, from an lstat.
// It classifies with the SAME vocabulary the POSIX path produces from fstat —
// state-file-symlink, EISDIR, state-file-not-regular, state-file-too-large — so
// a caller's error handling does not have to branch on platform. The size and
// type are re-checked on the opened descriptor afterwards; only the symlink
// decision is left with a TOCTOU window here, which is the documented residual.
function windowsPreOpen(info, file, limit) {
  if (info.isSymbolicLink()) {
    throw new PathBoundaryError('state-file-symlink', `refusing symlinked file: ${file}`);
  }
  assertBoundedRegular(info, file, limit);
  return info;
}

// Windows-only, and a narrowing rather than a fix.
//
// Without O_NOFOLLOW the no-follow decision has to be made by the pre-open
// lstat, which leaves a window: swap a symlink in after that lstat and the open
// follows it, and the post-open fstat then describes the TARGET, so it cannot
// notice. Re-examining the path after the open closes most of that window — the
// symlink is still there, so lstat reports it, and its identity does not match
// the descriptor's.
//
// Maximum residual, stated precisely: an attacker who can write into the project
// tree, and who swaps a symlink in after the pre-open lstat AND removes it again
// before this post-open lstat — two correctly timed operations inside one
// microsecond-scale window — causes this process to read the bytes at the
// symlink's target instead of the file's. That is the whole of the impact:
//   - it cannot make those bytes authoritative. Authority is bound to exact
//     approved bytes through a separate interactive transition, and bytes that
//     were not approved hash differently and render as quoted data;
//   - it cannot exceed the size bound, which is taken from the descriptor;
//   - it grants no read the attacker does not already have. The same identity
//     that plants the symlink can write the target's bytes straight into the
//     file, which needs no race at all.
// POSIX has no window: O_NOFOLLOW refuses inside open(2).
function assertWindowsIdentityUnchanged(info, after, file) {
  if (after === null || after.isSymbolicLink()) {
    throw new PathBoundaryError('state-file-symlink', `refusing symlinked file: ${file}`);
  }
  // NTFS supplies a file index and volume id; some filesystems report 0, in
  // which case the symlink check above is the only available signal.
  if (info.ino && after.ino && (info.ino !== after.ino || info.dev !== after.dev)) {
    throw new PathBoundaryError('state-file-changed', `file identity changed while it was being opened: ${file}`);
  }
}

function assertBoundedRegular(info, file, limit) {
  if (info.isDirectory()) {
    const error = new Error(`EISDIR: illegal operation on a directory, read ${file}`);
    error.code = 'EISDIR';
    throw error;
  }
  if (!info.isFile()) {
    throw new PathBoundaryError('state-file-not-regular', `refusing non-regular file: ${file}`);
  }
  // Apparent size, checked before a single byte is allocated: a sparse file
  // reports its full logical length here, so an 8 GiB hole is refused for the
  // cost of one fstat.
  if (info.size > limit) {
    throw new PathBoundaryError('state-file-too-large', `file exceeds the ${limit}-byte read bound: ${file}`);
  }
}

function finishBoundedRead(bytes, read, info, file, limit) {
  const cap = Math.min(info.size, limit);
  if (read > cap) {
    throw new PathBoundaryError(
      cap >= limit ? 'state-file-too-large' : 'state-file-changed',
      cap >= limit
        ? `file exceeds the ${limit}-byte read bound: ${file}`
        : `file grew while it was being read: ${file}`,
    );
  }
  return bytes.subarray(0, read);
}

async function readWithinBound(info, handle, file, limit) {
  assertBoundedRegular(info, file, limit);
  const bytes = Buffer.allocUnsafe(Math.min(info.size, limit) + 1);
  let read = 0;
  let chunk = 0;
  do {
    ({ bytesRead: chunk } = await handle.read(bytes, read, bytes.length - read, read));
    read += chunk;
  } while (chunk > 0 && read < bytes.length);
  return finishBoundedRead(bytes, read, info, file, limit);
}

// THE write that pairs with readBoundedRegularFile: for a repository-controlled
// file this product both reads and rewrites.
//
// `fs.writeFile` truncates and then writes, so it publishes an empty file and
// then fills it. A concurrent reader — and `noosphere watch` means there is
// usually one — whose fstat lands inside that window sees size 0 and reads zero
// bytes with NO error, which is indistinguishable from a file the user emptied.
// The read-modify-write callers then write that emptiness back. Measured before
// this existed: one writer looping writeFile against one reader looping
// readBoundedRegularFile returned a silent empty read 5.6% of the time, plus
// 0.9% spurious `state-file-changed` refusals when the fstat and the read
// straddled the window instead.
//
// Writing a sibling temp file and rename(2)ing it over the target closes both:
// rename is atomic, so a reader sees either the whole old file or the whole new
// one and never the gap between them. This is deliberately NOT
// atomicOwnerOnlyWrite — these are ordinary project files (AGENTS.md,
// .git/info/exclude, .noosphere/*.md) that must keep normal permissions and must
// not drag a 0700 mode onto the directories that hold them.
//
// The target is refused if it is a symlink or a non-regular file, before and
// after the temp write: rename would replace the LINK rather than follow it, so
// silently redirecting a symlinked adapter file into a fresh regular file is a
// behaviour change the caller has to opt out of by fixing the path first.
export async function atomicRepositoryWrite(file, data, options = {}) {
  const absolute = path.resolve(file);
  const directory = path.dirname(absolute);
  await mkdir(directory, { recursive: true });
  await assertFinalNotReparse(absolute);
  const temporary = path.join(directory, `.${path.basename(absolute)}.${randomUUID()}.tmp`);
  try {
    // 'wx' so a temp path that somehow already exists is refused rather than
    // written through; the UUID makes that a fault, not an attack surface.
    await writeFile(temporary, buffer(data), { flag: 'wx' });
    await assertFinalNotReparse(absolute);
    await replaceWithRetry(options.rename ?? rename, temporary, absolute, options);
    if ((options.platform ?? process.platform) !== 'win32') await fsyncDir(directory);
  } catch (error) {
    // Never leave a stray .tmp in someone's working tree.
    await safeCleanup(temporary);
    throw normalizeSecurityError(error);
  }
}

// Windows only, and the reason the atomic write needs a retry at all.
//
// `MoveFileEx(..., REPLACE_EXISTING)` requires DELETE access on the destination,
// and Node opens files without `FILE_SHARE_DELETE`, so a reader that merely has
// the target OPEN makes the replace fail with EPERM (or EACCES/EBUSY, and the
// same from an indexer or scanner holding a handle). POSIX `rename(2)` has no
// such constraint and never enters this path.
//
// Retrying is the honest fix. The alternative — falling back to a truncating
// write when the replace is refused — would reintroduce on Windows exactly the
// empty-file window this function exists to close, and it would do so precisely
// when a reader is known to be present, which is the worst possible moment. A
// reader holds the file for microseconds, so the budget below is enormous
// relative to the contention; exhausting it means something is holding the file
// open indefinitely, and that must surface as an error rather than as a silent
// downgrade.
const REPLACE_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const REPLACE_ATTEMPTS = 50;
const REPLACE_BACKOFF_MS = 10;

async function replaceWithRetry(renameImpl, from, to, options = {}) {
  const platform = options.platform ?? process.platform;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await renameImpl(from, to);
      return;
    } catch (error) {
      if (platform !== 'win32'
        || attempt >= REPLACE_ATTEMPTS
        || !REPLACE_RETRY_CODES.has(error.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, REPLACE_BACKOFF_MS));
    }
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
