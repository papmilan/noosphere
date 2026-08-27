import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import { chmod, lstat, mkdir, open, opendir, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
// O_NONBLOCK is what makes opening an unknown filesystem object safe. O_NOFOLLOW
// only refuses a symlinked final component; a FIFO opened O_RDONLY blocks in
// open(2) until a writer appears, which is indefinite and produces no error code
// — no amount of error classification recovers from it. With O_NONBLOCK the open
// returns immediately and fstat then decides what was actually opened.
const NONBLOCK = fs.constants.O_NONBLOCK || 0;
const WINDOWS_SCRIPT = fileURLToPath(new URL('./windows-owner-only.ps1', import.meta.url));
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

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

function fileSnapshot(info) {
  return Object.freeze({
    dev: String(info.dev),
    gid: String(info.gid),
    ino: String(info.ino),
    mode: Number(info.mode),
    mtimeNs: String(info.mtimeNs),
    nlink: Number(info.nlink),
    size: Number(info.size),
    uid: String(info.uid),
  });
}

function sameSnapshot(left, right) {
  return left.dev === right.dev &&
    left.gid === right.gid &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.uid === right.uid;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function assertSafeDestinationParents(root, directory, options) {
  const relative = path.relative(root, directory);
  let current = root;
  for (const segment of relative === '' ? [] : relative.split(path.sep)) {
    current = path.join(current, segment);
    const info = await lstat(current, { bigint: true });
    if (info.isSymbolicLink()) {
      throw new PathBoundaryError(
        'state-dir-symlink',
        `refusing symlinked destination parent: ${current}`,
      );
    }
    if (!info.isDirectory()) {
      throw new PathBoundaryError(
        'state-dir-not-directory',
        `destination parent is not a directory: ${current}`,
      );
    }
    if (typeof process.getuid === 'function' &&
        info.uid !== BigInt(process.getuid())) {
      throw new PathBoundaryError(
        'state-dir-owner-mismatch',
        `destination parent is not owned by the current user: ${current}`,
      );
    }
    if ((options.platform ?? process.platform) !== 'win32' &&
        (Number(info.mode) & 0o022) !== 0) {
      throw new PathBoundaryError(
        'state-dir-unsafe-mode',
        `destination parent is writable by group or other: ${current}`,
      );
    }
  }
}

export async function inspectOwnerOnlyDestination(file, options = {}) {
  const resolved = rootAndDirectory(file, options.root);
  const parent = await assertContainedChain(resolved.root, resolved.directory);
  if (parent === null) {
    throw new PathBoundaryError(
      'state-destination-parent-missing',
      `destination parent is missing: ${resolved.directory}`,
    );
  }
  await assertSafeDestinationParents(
    resolved.root,
    resolved.directory,
    options,
  );
  let info;
  try {
    info = await lstat(resolved.file, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return Object.freeze({
        path: resolved.file,
        root: resolved.root,
        state: 'absent',
      });
    }
    throw error;
  }
  if (info.isSymbolicLink()) {
    throw new PathBoundaryError(
      'state-file-symlink',
      `refusing symlinked destination: ${resolved.file}`,
    );
  }
  if (!info.isFile()) {
    throw new PathBoundaryError(
      'state-file-not-regular',
      `refusing non-regular destination: ${resolved.file}`,
    );
  }
  if (Number(info.nlink) !== 1) {
    throw new PathBoundaryError(
      'state-file-hard-link',
      `refusing multiply-linked destination: ${resolved.file}`,
    );
  }
  if (typeof process.getuid === 'function' &&
      info.uid !== BigInt(process.getuid())) {
    throw new PathBoundaryError(
      'state-file-owner-mismatch',
      `destination is not owned by the current user: ${resolved.file}`,
    );
  }
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32' && (Number(info.mode) & 0o022) !== 0) {
    throw new PathBoundaryError(
      'state-file-unsafe-mode',
      `destination is writable by group or other: ${resolved.file}`,
    );
  }
  // The POSIX branch above asks "can group or other WRITE this?"; this asks the
  // same question of Windows. It is not verifyOwnerOnlyWindows: this function
  // observes restore DESTINATIONS, which are repository files with inherited
  // ACLs, and the owner-only DACL that owner-local state carries is enforced
  // where that state is written (the helper's write/read/repair actions), not
  // here. See SEC-05 Phase 4C Finding 4.
  if (platform === 'win32') await verifyNoForeignWriteWindowsAsync(resolved.file, options);
  const maxBytes = options.maxBytes ?? 1_048_576;
  const bytes = await readBoundedRegularFile(resolved.file, {
    ...options,
    maxBytes,
    root: resolved.root,
  });
  const after = await lstat(resolved.file, { bigint: true });
  const beforeSnapshot = fileSnapshot(info);
  const afterSnapshot = fileSnapshot(after);
  if (!sameSnapshot(beforeSnapshot, afterSnapshot)) {
    throw new PathBoundaryError(
      'state-destination-changed',
      `destination changed during inspection: ${resolved.file}`,
    );
  }
  return Object.freeze({
    path: resolved.file,
    root: resolved.root,
    state: 'present',
    contentHash: sha256(bytes),
    byteLength: bytes.length,
    snapshot: afterSnapshot,
  });
}

function validatePreparedReplacement(prepared, options = {}) {
  if (!prepared || typeof prepared !== 'object' ||
      typeof prepared.temporaryPath !== 'string' ||
      typeof prepared.destination?.path !== 'string' ||
      typeof prepared.temporarySnapshot !== 'object') {
    throw new PathBoundaryError(
      'state-replacement-invalid',
      'prepared replacement is invalid',
    );
  }
  const resolved = rootAndDirectory(
    prepared.destination.path,
    options.root ?? prepared.destination.root,
  );
  const expectedPrefix = `.${path.basename(resolved.file)}.`;
  if (path.dirname(prepared.temporaryPath) !== resolved.directory ||
      !path.basename(prepared.temporaryPath).startsWith(expectedPrefix) ||
      !path.basename(prepared.temporaryPath).endsWith('.restore-tmp')) {
    throw new PathBoundaryError(
      'state-replacement-invalid',
      'prepared replacement temporary path is invalid',
    );
  }
  return resolved;
}

export async function prepareOwnerOnlyReplacement(file, data, options = {}) {
  const bytes = buffer(data);
  const maxBytes = options.maxBytes ?? 1_048_576;
  if (bytes.length > maxBytes) {
    throw new PathBoundaryError(
      'state-file-too-large',
      `replacement exceeds the ${maxBytes}-byte bound: ${file}`,
    );
  }
  const destination = await inspectOwnerOnlyDestination(file, {
    ...options,
    maxBytes,
  });
  if (options.expectedDestination &&
      !sameDestinationObservation(destination, options.expectedDestination)) {
    throw new PathBoundaryError(
      'state-destination-changed',
      `destination changed after the caller's final barrier: ${file}`,
    );
  }
  const resolved = rootAndDirectory(file, options.root);
  const writeExclusive = options.writeExclusive ?? writeOwnerOnlyFileExclusive;
  for (let attempt = 0; attempt < 128; attempt += 1) {
    const token = (options.randomUUID ?? randomUUID)();
    const temporaryPath = path.join(
      resolved.directory,
      `.${path.basename(resolved.file)}.${token}.restore-tmp`,
    );
    try {
      await writeExclusive(temporaryPath, bytes, {
        ...options,
        root: resolved.root,
        mode: 0o600,
      });
      const temporary = await inspectOwnerOnlyDestination(temporaryPath, {
        ...options,
        root: resolved.root,
        maxBytes,
      });
      if (temporary.state !== 'present' ||
          temporary.byteLength !== bytes.length ||
          temporary.contentHash !== sha256(bytes)) {
        throw new PathBoundaryError(
          'state-write-incomplete',
          `replacement temporary write is incomplete: ${temporaryPath}`,
        );
      }
      return Object.freeze({
        destination,
        temporaryPath,
        temporarySnapshot: temporary.snapshot,
        byteLength: bytes.length,
        contentHash: sha256(bytes),
      });
    } catch (error) {
      if (error.code === 'state-file-exists' || error.code === 'EEXIST') {
        continue;
      }
      await safeCleanup(temporaryPath);
      throw normalizeSecurityError(error);
    }
  }
  throw new PathBoundaryError(
    'state-replacement-collision-limit',
    'replacement temporary-name collisions exceeded the fixed retry limit',
  );
}

async function revalidatePreparedDestination(prepared, options) {
  const observed = await inspectOwnerOnlyDestination(
    prepared.destination.path,
    {
      ...options,
      root: options.root ?? prepared.destination.root,
      maxBytes: options.maxBytes ?? 1_048_576,
    },
  );
  const expected = prepared.destination;
  if (observed.state !== expected.state ||
      (expected.state === 'present' &&
       (observed.contentHash !== expected.contentHash ||
        observed.byteLength !== expected.byteLength ||
        !sameSnapshot(observed.snapshot, expected.snapshot)))) {
    throw new PathBoundaryError(
      'state-destination-changed',
      `destination changed after replacement preparation: ${expected.path}`,
    );
  }
  return observed;
}

function sameDestinationObservation(observed, expected) {
  return observed?.state === expected?.state &&
    observed?.path === expected?.path &&
    (expected?.state === 'absent' ||
      (observed?.contentHash === expected?.contentHash &&
       observed?.byteLength === expected?.byteLength &&
       sameSnapshot(observed.snapshot, expected.snapshot)));
}

async function fsyncDirectoryStrict(directory) {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!isIgnorableDirFsyncError(error)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function commitOwnerOnlyReplacement(prepared, options = {}) {
  validatePreparedReplacement(prepared, options);
  await revalidatePreparedDestination(prepared, options);
  const temporary = await inspectOwnerOnlyDestination(
    prepared.temporaryPath,
    {
      ...options,
      root: options.root ?? prepared.destination.root,
      maxBytes: options.maxBytes ?? 1_048_576,
    },
  );
  if (temporary.state !== 'present' ||
      !sameSnapshot(temporary.snapshot, prepared.temporarySnapshot) ||
      temporary.byteLength !== prepared.byteLength ||
      temporary.contentHash !== prepared.contentHash) {
    throw new PathBoundaryError(
      'state-replacement-temporary-changed',
      'prepared replacement temporary file changed',
    );
  }
  await replaceWithRetry(
    options.rename ?? rename,
    prepared.temporaryPath,
    prepared.destination.path,
    options,
  );
  if ((options.platform ?? process.platform) !== 'win32') {
    try {
      await (options.fsyncDirectory ?? fsyncDirectoryStrict)(
        path.dirname(prepared.destination.path),
      );
    } catch (cause) {
      const error = new PathBoundaryError(
        'state-directory-fsync-failed-after-replace',
        'destination was replaced but directory durability was not confirmed',
        cause,
      );
      error.destinationReplaced = true;
      throw error;
    }
  }
  return Object.freeze({
    path: prepared.destination.path,
    byteLength: prepared.byteLength,
    contentHash: prepared.contentHash,
  });
}

export async function discardOwnerOnlyReplacement(prepared, options = {}) {
  validatePreparedReplacement(prepared, options);
  let info;
  try {
    info = await lstat(prepared.temporaryPath, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (!info.isFile() ||
      !sameSnapshot(fileSnapshot(info), prepared.temporarySnapshot)) {
    throw new PathBoundaryError(
      'state-replacement-temporary-changed',
      'refusing to remove a changed replacement temporary file',
    );
  }
  await rm(prepared.temporaryPath, { force: false });
  return true;
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
      await Promise.resolve((options.windowsAction ?? defaultWindowsActionAsync)({
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
    return buffer(await Promise.resolve((options.windowsAction ?? defaultWindowsActionAsync)({
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

// Read the newest bounded window of a regular file without requiring the whole
// file to fit in memory. This is for append-only inputs such as Claude JSONL
// transcripts: long sessions may legitimately exceed the ordinary whole-file
// bound, while only their final records are relevant at SessionEnd.
//
// The same open-time type and symlink protections as readBoundedRegularFile
// apply. A file that changes while its tail is being read is rejected rather
// than returning a silently stale or torn window; callers may retry or degrade
// to a safe fallback.
export async function readBoundedRegularFileTail(file, { maxBytes } = {}) {
  const limit = boundedReadLimit(maxBytes);
  const absolute = path.resolve(file);
  if (process.platform === 'win32') {
    const before = await lstat(absolute).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (before === null) return null;
    if (before.isSymbolicLink()) {
      throw new PathBoundaryError('state-file-symlink', `refusing symlinked file: ${absolute}`);
    }
    assertRegularFile(before, absolute);
  }

  let handle;
  try {
    handle = await open(absolute, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw boundedOpenError(error, absolute);
  }
  try {
    const before = await handle.stat();
    if (process.platform === 'win32') {
      const afterOpen = await lstat(absolute).catch(() => null);
      assertWindowsIdentityUnchanged(before, afterOpen, absolute);
    }
    assertRegularFile(before, absolute);
    const length = Math.min(before.size, limit);
    const start = before.size - length;
    const bytes = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(bytes, read, length - read, start + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    const after = await handle.stat();
    if (read !== length || !sameReadObservation(before, after)) {
      throw new PathBoundaryError(
        'state-file-changed',
        `file changed while its bounded tail was being read: ${absolute}`,
      );
    }
    return bytes;
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

function assertRegularFile(info, file) {
  if (info.isDirectory()) {
    const error = new Error(`EISDIR: illegal operation on a directory, read ${file}`);
    error.code = 'EISDIR';
    throw error;
  }
  if (!info.isFile()) {
    throw new PathBoundaryError('state-file-not-regular', `refusing non-regular file: ${file}`);
  }
}

function sameReadObservation(before, after) {
  return before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs;
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
  assertRegularFile(info, file);
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
  const platform = options.platform ?? process.platform;
  if (options.root) {
    await ensureContainedDir(path.resolve(options.root), directory, {
      mode: options.directoryMode ?? 0o755,
    });
  } else {
    await mkdir(directory, { recursive: true });
  }
  await assertFinalNotReparse(absolute);
  const temporary = path.join(directory, `.${path.basename(absolute)}.${randomUUID()}.tmp`);
  try {
    // 'wx' so a temp path that somehow already exists is refused rather than
    // written through; the UUID makes that a fault, not an attack surface.
    await writeFile(temporary, buffer(data), { flag: 'wx' });
    // A rename replaces the inode, so without carrying the destination's mode
    // forward a private 0600/0640 file silently becomes the process default
    // (commonly 0644). New files keep the ordinary umask-derived mode.
    const current = await assertFinalNotReparse(absolute);
    if (current && platform !== 'win32') await chmod(temporary, current.mode & 0o777);
    if (current && platform === 'win32') {
      await Promise.resolve((options.copyWindowsAcl ?? defaultCopyWindowsAclAsync)(absolute, temporary));
    }
    await replaceWithRetry(options.rename ?? rename, temporary, absolute, options);
    if (platform !== 'win32') await fsyncDir(directory);
  } catch (error) {
    // Never leave a stray .tmp in someone's working tree.
    await safeCleanup(temporary);
    throw normalizeSecurityError(error);
  }
}

const APPEND_LOCK_MAX_BYTES = 4096;
const PROCESS_GUARD_MARKER = new RegExp(
  `^owner-([1-9][0-9]*)-(${LOCK_TOKEN_V4.source.slice(1, -1)})$`,
);

function appendLockContention(error, platform) {
  if (error?.code === 'EEXIST') return true;
  return platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(error?.code);
}

async function readAppendLock(lock, root, platform) {
  let bytes;
  try {
    bytes = await readBoundedRegularFile(lock, {
      maxBytes: APPEND_LOCK_MAX_BYTES,
      root,
      platform,
    });
  } catch {
    // A symlink, FIFO, oversized file, or unreadable object is never safe to
    // reclaim automatically. The bounded waiter will fail closed instead.
    return Object.freeze({ kind: 'unsafe', record: null });
  }
  if (bytes === null) return Object.freeze({ kind: 'missing', record: null });
  try {
    const record = JSON.parse(STRICT_UTF8.decode(bytes));
    if (
      record === null ||
      Array.isArray(record) ||
      typeof record !== 'object' ||
      !Number.isInteger(record.pid) ||
      record.pid <= 0 ||
      typeof record.token !== 'string' ||
      !LOCK_TOKEN_V4.test(record.token)
    ) {
      return Object.freeze({ kind: 'malformed', record: null });
    }
    return Object.freeze({ kind: 'valid', record });
  } catch {
    return Object.freeze({ kind: 'malformed', record: null });
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but cannot be signalled. Every unknown
    // result is treated as live; only the OS's explicit ESRCH is reclaimable.
    return error?.code !== 'ESRCH';
  }
}

async function staleAppendLock(lock, root, platform) {
  const observed = await readAppendLock(lock, root, platform);
  if (observed.kind !== 'valid') return false;
  return !processIsAlive(observed.record.pid);
}

async function processGuardState(guard) {
  const info = await lstat(guard).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (info === null) return Object.freeze({ kind: 'missing' });
  if (info.isSymbolicLink() || !info.isDirectory()) {
    return Object.freeze({ kind: 'unsafe' });
  }

  const entries = [];
  let directory;
  try {
    directory = await opendir(guard);
    for await (const entry of directory) {
      entries.push(entry);
      if (entries.length > 2) break;
    }
  } catch (error) {
    if (error.code === 'ENOENT') return Object.freeze({ kind: 'missing' });
    throw error;
  } finally {
    await directory?.close().catch((error) => {
      if (error.code !== 'ERR_DIR_CLOSED') throw error;
    });
  }
  if (entries.length === 0) return Object.freeze({ kind: 'empty' });
  if (entries.length > 2) return Object.freeze({ kind: 'unsafe' });

  const markerEntry = entries.find((entry) => PROCESS_GUARD_MARKER.test(entry.name));
  if (!markerEntry) {
    // macOS writes an AppleDouble companion beside a file on filesystems that
    // cannot store its metadata natively. If a process dies after unlinking the
    // real marker but before the companion disappears, the exact companion is
    // still sufficient to identify the dead owner. No other lone entry is.
    if (entries.length !== 1 || !entries[0].isFile() || !entries[0].name.startsWith('._')) {
      return Object.freeze({ kind: 'unsafe' });
    }
    const companionMatch = PROCESS_GUARD_MARKER.exec(entries[0].name.slice(2));
    if (!companionMatch) return Object.freeze({ kind: 'unsafe' });
    const companionPid = Number(companionMatch[1]);
    if (!Number.isSafeInteger(companionPid) || companionPid <= 0) {
      return Object.freeze({ kind: 'unsafe' });
    }
    return Object.freeze({
      kind: 'sidecar-only',
      pid: companionPid,
      marker: null,
      sidecar: entries[0].name,
    });
  }
  if (!markerEntry.isFile()) return Object.freeze({ kind: 'unsafe' });
  const match = PROCESS_GUARD_MARKER.exec(markerEntry.name);
  const companion = entries.find((entry) => entry.name !== markerEntry.name);
  if (companion && (companion.name !== `._${markerEntry.name}` || !companion.isFile())) {
    return Object.freeze({ kind: 'unsafe' });
  }
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return Object.freeze({ kind: 'unsafe' });
  return Object.freeze({
    kind: 'owned',
    pid,
    marker: markerEntry.name,
    sidecar: companion?.name ?? null,
  });
}

async function recoverProcessGuard(guard) {
  const state = await processGuardState(guard);
  if (state.kind === 'missing') return true;
  if (state.kind === 'unsafe') {
    throw new PathBoundaryError(
      'state-process-guard-unsafe',
      `refusing unsafe process guard: ${guard}`,
    );
  }
  if (state.kind === 'owned' || state.kind === 'sidecar-only') {
    if (processIsAlive(state.pid)) return false;
    if (state.marker !== null) {
      try {
        // Remove only the exact dead owner's marker. If another reclaimer
        // already removed it, do not touch whatever may now occupy the fixed
        // guard path.
        await rm(path.join(guard, state.marker), { force: false });
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    } else {
      try {
        await rm(path.join(guard, state.sidecar), { force: false });
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    }
    if (state.marker !== null && state.sidecar !== null) {
      // On AppleDouble filesystems unlinking the marker normally removes this
      // companion as one operation. The explicit exact-name cleanup also
      // handles copied or simulated sidecars and cannot target a successor,
      // whose UUID-named companion differs.
      await rm(path.join(guard, state.sidecar), { force: true });
    }
  }

  try {
    await rmdir(guard);
    return true;
  } catch (error) {
    // A prepared contender can atomically replace the now-empty directory
    // before rmdir. Its marker makes rmdir fail, preserving the successor.
    if (['ENOENT', 'EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code)) {
      return error.code === 'ENOENT';
    }
    throw error;
  }
}

function processGuardContention(error) {
  return ['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES', 'EBUSY'].includes(error?.code);
}

async function cleanupProcessGuardCandidate(candidate, marker) {
  await rm(path.join(candidate, marker), { force: true }).catch(() => undefined);
  await rmdir(candidate).catch(() => undefined);
}

// A crash-recoverable process guard with no age heuristic. The owner marker is
// prepared inside a unique directory before that directory is atomically moved
// to the fixed guard path. Consequently, the fixed path is never a live but
// unidentifiable empty guard. Recovery removes only an exact dead-owner marker;
// its exact AppleDouble companion is recognized on macOS external volumes, and
// rmdir cannot delete a successor because the successor's marker makes it
// non-empty.
export async function tryAcquireOwnerProcessGuard(guard, options = {}) {
  const resolved = rootAndDirectory(guard, options.root);
  await ensureContainedDir(resolved.root, resolved.directory, {
    mode: options.directoryMode ?? 0o700,
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = randomUUID();
    const marker = `owner-${process.pid}-${token}`;
    const candidate = `${resolved.file}.candidate-${token}`;
    await mkdir(candidate, { mode: 0o700 });
    try {
      await writeFile(path.join(candidate, marker), '', { flag: 'wx', mode: 0o600 });
      try {
        await rename(candidate, resolved.file);
      } catch (error) {
        if (!processGuardContention(error)) throw error;
        const existing = await lstat(resolved.file).catch((readError) => {
          if (readError.code === 'ENOENT') return null;
          throw readError;
        });
        if (existing === null) continue;
        if (existing.isSymbolicLink() || !existing.isDirectory()) {
          throw new PathBoundaryError(
            'state-process-guard-unsafe',
            `refusing unsafe process guard: ${resolved.file}`,
            error,
          );
        }
        if (await recoverProcessGuard(resolved.file)) continue;
        return null;
      }

      let released = false;
      return Object.freeze({
        file: resolved.file,
        token,
        async release() {
          if (released) return;
          try {
            await rm(path.join(resolved.file, marker), { force: false });
          } catch (error) {
            if (error.code === 'ENOENT') {
              throw new PathBoundaryError(
                'state-process-guard-not-owner',
                'process guard owner marker disappeared before release',
                error,
              );
            }
            throw error;
          }
          // macOS external volumes may materialize this exact metadata sidecar.
          // Removing the real marker usually removes it too; force makes the
          // cleanup harmless on native filesystems and copied test fixtures.
          await rm(path.join(resolved.file, `._${marker}`), { force: true });
          try {
            await rmdir(resolved.file);
          } catch (error) {
            if (!['ENOENT', 'EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code)) {
              throw error;
            }
          }
          released = true;
        },
      });
    } finally {
      await cleanupProcessGuardCandidate(candidate, marker);
    }
  }
  return null;
}

// A staleness check followed by a bare unlink has a classic replacement race:
// another waiter can install a live lock between those calls and then be
// deleted. Serialize reclaimers behind the crash-recoverable process guard and
// repeat the staleness decision while that guard is held.
async function reclaimStaleAppendLock(lock, root, platform) {
  const guard = await tryAcquireOwnerProcessGuard(`${lock}.reclaim`, { root });
  if (guard === null) return false;
  try {
    if (!(await staleAppendLock(lock, root, platform))) return false;
    await rm(lock, { force: true });
    return true;
  } finally {
    await guard.release().catch(() => undefined);
  }
}

export async function appendRepositoryFile(file, data, options = {}) {
  const resolved = rootAndDirectory(file, options.root);
  const limit = boundedReadLimit(options.maxBytes);
  const bytes = buffer(data);
  const skipIfContains = options.skipIfContains === undefined
    ? null
    : buffer(options.skipIfContains);
  if (bytes.length > limit) {
    throw new PathBoundaryError('state-file-too-large', `append exceeds the ${limit}-byte bound: ${resolved.file}`);
  }
  if (skipIfContains !== null && skipIfContains.length === 0) {
    throw new PathBoundaryError(
      'state-append-marker-empty',
      'an idempotent append marker must not be empty',
    );
  }
  if (skipIfContains !== null && !bytes.includes(skipIfContains)) {
    throw new PathBoundaryError(
      'state-append-marker-missing',
      'the appended bytes must contain their idempotency marker',
    );
  }
  await ensureContainedDir(resolved.root, resolved.directory, {
    mode: options.directoryMode ?? 0o755,
  });
  const lock = `${resolved.file}.append.lock`;
  const platform = options.platform ?? process.platform;
  let lockHandle;
  let ownsLock = false;
  const maxAttempts = options.lockAttempts ?? 100;
  const lockBackoffMs = options.lockBackoffMs ?? 10;
  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
    throw new PathBoundaryError('state-append-options-invalid', 'lockAttempts must be a positive integer');
  }
  if (!Number.isFinite(lockBackoffMs) || lockBackoffMs < 0) {
    throw new PathBoundaryError('state-append-options-invalid', 'lockBackoffMs must be a non-negative finite number');
  }
  const token = randomUUID();
  try {
    for (let attempt = 1; ; attempt += 1) {
      let opened;
      try {
        opened = await (options.open ?? open)(
          lock,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | NOFOLLOW,
          0o600,
        );
        await opened.writeFile(JSON.stringify({ pid: process.pid, token, created_at: Date.now() }));
        await opened.sync();
        lockHandle = opened;
        ownsLock = true;
        break;
      } catch (error) {
        if (opened) {
          await opened.close().catch(() => undefined);
          await rm(lock, { force: true }).catch(() => undefined);
        }
        let contention = appendLockContention(error, platform);
        if (platform === 'win32' && contention && error.code !== 'EEXIST') {
          const lockInfo = await assertFinalNotReparse(lock);
          contention = lockInfo === null || lockInfo.isFile();
        }
        if (!contention) throw error;
        if (attempt >= maxAttempts) {
          throw new PathBoundaryError('state-append-busy', `append lock remained busy: ${lock}`, error);
        }
        const reclaimed = await reclaimStaleAppendLock(
          lock,
          resolved.root,
          platform,
        );
        if (reclaimed) continue;
        await new Promise((resolve) => setTimeout(resolve, Math.random() * lockBackoffMs));
      }
    }
    await lockHandle.close();
    lockHandle = null;
    const current = await readBoundedRegularFile(resolved.file, {
      maxBytes: limit,
      platform: options.platform,
    });
    const existing = current ?? Buffer.alloc(0);
    // This check deliberately happens after taking the same lock as the append.
    // A read-before-lock check lets two SessionEnd processes both observe the
    // marker as absent and then serialize two identical entries. Keeping the
    // predicate and mutation in one critical section makes the append exactly
    // once for every marker, including across processes.
    if (skipIfContains !== null && existing.includes(skipIfContains)) {
      return Object.freeze({
        appended: false,
        path: resolved.file,
        byteLength: existing.length,
      });
    }
    if (existing.length + bytes.length > limit) {
      throw new PathBoundaryError('state-file-too-large', `append exceeds the ${limit}-byte bound: ${resolved.file}`);
    }
    await atomicRepositoryWrite(resolved.file, Buffer.concat([existing, bytes]), {
      ...options,
      root: resolved.root,
    });
    return Object.freeze({
      appended: true,
      path: resolved.file,
      byteLength: existing.length + bytes.length,
    });
  } catch (error) {
    throw normalizeSecurityError(error);
  } finally {
    await lockHandle?.close().catch(() => undefined);
    if (ownsLock) {
      const current = await readAppendLock(lock, resolved.root, platform);
      if (current.kind === 'valid' && current.record.token === token) {
        await rm(lock, { force: true }).catch(() => undefined);
      }
    }
  }
}

export async function removeRepositoryFile(file, options = {}) {
  const resolved = rootAndDirectory(file, options.root);
  const parent = await assertContainedChain(resolved.root, resolved.directory);
  if (parent === null) return false;
  const current = await assertFinalNotReparse(resolved.file);
  if (current === null) return false;
  try {
    await (options.rm ?? rm)(resolved.file, { force: false });
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  return true;
}

export async function removeRepositoryDirectoryIfEmpty(directory, options = {}) {
  const absolute = path.resolve(directory);
  const root = options.root ? path.resolve(options.root) : trustedRootFor(path.dirname(absolute)).root;
  const parent = await assertContainedChain(root, path.dirname(absolute));
  if (parent === null) return false;
  const info = await lstat(absolute).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (info === null) return false;
  if (info.isSymbolicLink()) {
    throw new PathBoundaryError('state-dir-symlink', `refusing symlinked directory: ${absolute}`);
  }
  if (!info.isDirectory()) {
    throw new PathBoundaryError('state-dir-not-directory', `not a directory: ${absolute}`);
  }
  try {
    await rmdir(absolute);
    return true;
  } catch (error) {
    if (error.code === 'ENOTEMPTY') return false;
    throw error;
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
// The budget is wall-clock, not a retry count. `50 attempts * 10 ms` reads like
// 500 ms but is not: each attempt also pays for however long the failing
// `MoveFileEx` itself took, so the real ceiling drifted with the filesystem and
// the machine — and 500 ms was under the 1200 ms window atomic-write.test.js
// races a reader against this path for, so a slow enough runner could exhaust
// the budget inside a test written to prove the replace survives contention.
// A deadline says what is actually meant: keep trying while a reader could
// plausibly still be letting go, then fail honestly.
const REPLACE_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const REPLACE_BUDGET_MS = 5_000;
const REPLACE_BACKOFF_MS = 10;

async function replaceWithRetry(renameImpl, from, to, options = {}) {
  const platform = options.platform ?? process.platform;
  const deadline = Date.now() + (options.replaceBudgetMs ?? REPLACE_BUDGET_MS);
  for (;;) {
    try {
      await renameImpl(from, to);
      return;
    } catch (error) {
      if (platform !== 'win32'
        || Date.now() >= deadline
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

// SEC-05 Phase 4C Finding 4. The Windows counterpart of the POSIX
// `mode & 0o022` destination check, and deliberately NOT the owner-only check:
// a restore destination is a repository file that inherits the repository's
// ACL, so demanding an exact protected `{owner, SYSTEM, Administrators}` DACL
// refuses every real one. What must be refused is the same thing POSIX refuses
// — a principal other than the owner being able to modify the file.
//
// The helper reports facts (the owner SID, then every SID holding a write-ish
// right); the policy lives here, where it is testable without a Windows host.
// SYSTEM and Administrators are permitted for the same reason POSIX ignores
// root: they can take ownership regardless, so refusing them would be theatre.
const WINDOWS_PRIVILEGED_SIDS = Object.freeze(['S-1-5-18', 'S-1-5-32-544']);
const WINDOWS_WRITE_SID_LINE = /^(owner|write):S-1-(?:\d+-)+\d+$/;

export function verifyNoForeignWriteWindows(file, options = {}) {
  if ((options.platform ?? process.platform) !== 'win32') return [];
  assertFinalNotReparseSync(file);
  return windowsWriteSidPolicy((options.windowsAction ?? defaultWindowsAction)({
    action: 'write-sids', file: path.resolve(file), input: null,
  }), file);
}

// The same check reached through the persistent host. `inspectOwnerOnlyDestination`
// is the only production caller and is already async, and it is the call this
// whole file's Windows cost is concentrated in — one destination inspection per
// prepare, per revalidate, and per temporary. The sync export above stays for
// callers outside an async context; both hand their answer to the one policy
// function below, so there is exactly one place where "no foreign writer" is
// decided.
async function verifyNoForeignWriteWindowsAsync(file, options = {}) {
  if ((options.platform ?? process.platform) !== 'win32') return [];
  assertFinalNotReparseSync(file);
  return windowsWriteSidPolicy(await Promise.resolve((options.windowsAction ?? defaultWindowsActionAsync)({
    action: 'write-sids', file: path.resolve(file), input: null,
  })), file);
}

function windowsWriteSidPolicy(output, file) {
  const lines = buffer(output).toString('utf8').split(/\r?\n/)
    .map((value) => value.trim()).filter(Boolean);
  // Fail closed on anything unexpected: an unparseable answer is not "no
  // foreign writer", it is an unanswered question.
  if (lines.length === 0 || lines.some((line) => !WINDOWS_WRITE_SID_LINE.test(line))) {
    throw new PathBoundaryError(
      'state-acl-readback-failed',
      'Windows write-ACE enumeration returned an invalid response',
    );
  }
  const owners = lines.filter((line) => line.startsWith('owner:')).map((line) => line.slice(6));
  if (owners.length !== 1) {
    throw new PathBoundaryError(
      'state-acl-readback-failed',
      'Windows write-ACE enumeration did not report exactly one owner SID',
    );
  }
  const writers = [...new Set(
    lines.filter((line) => line.startsWith('write:')).map((line) => line.slice(6)),
  )].sort();
  const permitted = new Set([owners[0], ...WINDOWS_PRIVILEGED_SIDS]);
  const foreign = writers.filter((sid) => !permitted.has(sid));
  if (foreign.length > 0) {
    throw new PathBoundaryError(
      'state-destination-foreign-write',
      `destination is writable by a principal other than its owner: ${foreign.join(', ')}`,
    );
  }
  return writers;
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

const ACL_TRANSPORT_LIMIT = 16 * 1024 * 1024;
const ACL_ERROR_PATTERN = /NOOSPHERE_ACL_ERROR:([a-z0-9-]+):([^\r\n]*)/i;

function powershellArgs(...tail) {
  return [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', WINDOWS_SCRIPT, ...tail,
  ];
}

// The helper reports every refusal as one tagged line, and it reports it the same
// way on both transports: on stderr for a one-shot invocation, in an `err` frame
// for the host. So one parser serves both, and a caller's error codes do not
// depend on which transport answered.
function aclRefusal(text, fallbackCode, cause) {
  const match = String(text ?? '').match(ACL_ERROR_PATTERN);
  return new PathBoundaryError(
    match?.[1] ?? fallbackCode,
    match?.[2] || cause?.message || fallbackCode,
    cause,
  );
}

// Set NOOSPHERE_ACL_PROFILE=1 to get a per-action call count and cost breakdown
// on stderr at process exit. This is how the Windows cost was attributed in the
// first place, and it is the only way to re-check it: the machinery that makes
// these calls cheap is invisible from POSIX, where they never run.
const ACL_PROFILE = process.env.NOOSPHERE_ACL_PROFILE ? new Map() : null;

function recordAclCall(transport, action, startedAt) {
  if (ACL_PROFILE === null) return;
  const key = `${transport}:${action}`;
  const entry = ACL_PROFILE.get(key) ?? { calls: 0, ms: 0 };
  entry.calls += 1;
  entry.ms += Number(process.hrtime.bigint() - startedAt) / 1e6;
  ACL_PROFILE.set(key, entry);
}

if (ACL_PROFILE !== null) {
  process.on('exit', () => {
    const rows = [...ACL_PROFILE.entries()].sort((left, right) => right[1].ms - left[1].ms);
    const calls = rows.reduce((sum, [, entry]) => sum + entry.calls, 0);
    const ms = rows.reduce((sum, [, entry]) => sum + entry.ms, 0);
    // One line per process, prefixed so a CI log can be summed across the many
    // children these suites spawn.
    process.stderr.write(`NOOSPHERE_ACL_PROFILE total pid=${process.pid} calls=${calls} ms=${ms.toFixed(0)}\n`);
    for (const [key, entry] of rows) {
      process.stderr.write(
        `NOOSPHERE_ACL_PROFILE   ${key} calls=${entry.calls} ms=${entry.ms.toFixed(0)} mean=${(entry.ms / entry.calls).toFixed(1)}\n`,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// The owner-only ACL helper host.
//
// Windows has no ACL API in Node, so the exact-SID DACL has to be applied and
// verified by an external process. The ACL calls themselves are microseconds;
// STARTING the process that makes them is not — loading the CLR, the PowerShell
// engine, and the System.Security assemblies costs hundreds of milliseconds, and
// the restore and replay paths perform many file operations per transaction.
// Measured on windows-latest, restore-recovery.test.js spent 130-230 s per crash
// boundary against a few seconds on POSIX, essentially all of it in process
// startup rather than in ACL work.
//
// So startup is paid once per Node process and every subsequent operation is a
// framed request over the host's stdin/stdout. What is applied and verified does
// not change: the same script, the same actions, the same Set/Verify functions,
// the same error codes. Only the dispatch changes.
//
// The trust boundary does not move either. The host is this process's own child,
// spawned from the same absolute script path with the same arguments, and the
// only channel is the pipe pair that execFileSync was already using. Nothing is
// introduced that a third party could write to: no control file, no shared
// directory, no socket. Response frames echo the request id, so a desynchronised
// stream is detected and kills the host rather than letting one file's answer be
// matched to another file's question.
//
// Set NOOSPHERE_ACL_NO_HOST=1 to force the historical one-shot invocation per
// call. That is the baseline the host is measured against, and the escape hatch
// if a host ever misbehaves.
// ---------------------------------------------------------------------------
let aclHost = null;
let aclHostUnavailable = false;

function encodeAclField(value) {
  return value ? Buffer.from(String(value), 'utf8').toString('base64') : '-';
}

// Framing, kept pure and exported so it is covered on every platform. A framing
// bug is the one way this transport could hand a caller the wrong file's answer,
// and it would otherwise be exercised only on windows-latest.
//
// Request:  "<id> <action> <payloadLength> <base64Path> <base64Source>\n" + payload
// Paths are base64 so a path containing a space or a newline cannot shift a
// field; '-' stands for an absent one, since an empty field would collapse.
export function encodeAclRequestFrame({ id, action, file, source, payload }) {
  const bytes = payload ?? Buffer.alloc(0);
  const header = Buffer.from(
    `${id} ${action} ${bytes.length} ${encodeAclField(file)} ${encodeAclField(source)}\n`,
    'ascii',
  );
  return bytes.length === 0 ? header : Buffer.concat([header, bytes]);
}

// Response: "<id> ok|err <length>\n" + payload. Returns null when the buffer does
// not hold a whole frame yet, and throws when it holds something that is not a
// frame at all — an unparseable stream is not an answer, so it must fail closed
// rather than be skipped past.
export function decodeAclResponseFrame(bytes) {
  const newline = bytes.indexOf(0x0a);
  if (newline < 0) {
    if (bytes.length > 8192) {
      throw new PathBoundaryError('state-acl-failed', 'the ACL host sent an oversized response header');
    }
    return null;
  }
  const fields = bytes.subarray(0, newline).toString('ascii').trim().split(' ');
  const length = fields.length === 3 ? Number(fields[2]) : Number.NaN;
  if (!['ok', 'err'].includes(fields[1])
    || !/^[0-9]+$/.test(fields[2] ?? '')
    || !Number.isSafeInteger(length)
    || length > ACL_TRANSPORT_LIMIT) {
    throw new PathBoundaryError('state-acl-failed', 'the ACL host sent a malformed response header');
  }
  const end = newline + 1 + length;
  if (bytes.length < end) return null;
  return {
    id: fields[0],
    status: fields[1],
    body: Buffer.from(bytes.subarray(newline + 1, end)),
    rest: bytes.subarray(end),
  };
}

// Idle must not hold the process open — these suites already spawn enough
// children — but an in-flight request must, or the process could exit between
// asking for a DACL and hearing the answer. So the stdio handles are referenced
// exactly while the queue is non-empty.
function setAclHostRef(host, active) {
  for (const stream of [host.child.stdin, host.child.stdout, host.child.stderr]) {
    if (active) stream?.ref?.();
    else stream?.unref?.();
  }
}

function failAclHost(host, code, cause) {
  if (host.failure) return;
  const detail = host.stderr.trim();
  host.failure = new PathBoundaryError(
    code,
    `${cause?.message ?? 'the Windows ACL helper host failed'}${detail ? ` (${detail})` : ''}`,
    cause,
  );
  // Marks "the transport broke", as opposed to "the helper refused this file".
  // Only the former may be repeated through a fresh process.
  host.failure.aclTransport = true;
  if (aclHost === host) aclHost = null;
  try { host.child.kill(); } catch { /* already gone */ }
  const abandoned = host.queue.splice(0);
  setAclHostRef(host, false);
  for (const pending of abandoned) pending.reject(host.failure);
}

function drainAclHost(host) {
  for (;;) {
    let frame;
    try {
      frame = decodeAclResponseFrame(host.stdout);
    } catch (error) {
      failAclHost(host, 'state-acl-failed', error);
      return;
    }
    if (frame === null) return;
    host.stdout = frame.rest;
    const pending = host.queue.shift();
    // A response that does not match the request it is being handed to makes
    // every later answer suspect, including "this DACL is correct". Fail closed
    // on the whole session rather than trust one more frame.
    if (!pending || pending.id !== frame.id) {
      const desync = new PathBoundaryError('state-acl-failed', 'the ACL host response stream desynchronised');
      desync.aclTransport = true;
      pending?.reject(desync);
      failAclHost(host, 'state-acl-failed', new Error('the ACL host response stream desynchronised'));
      return;
    }
    setAclHostRef(host, host.queue.length > 0);
    if (frame.status === 'ok') pending.resolve(frame.body);
    else pending.reject(aclRefusal(frame.body.toString('utf8'), 'state-acl-failed'));
  }
}

function startAclHost() {
  const child = spawn('powershell.exe', powershellArgs('serve'), {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const host = { child, queue: [], stdout: Buffer.alloc(0), stderr: '', seq: 0, failure: null };
  // A spawn that never produced a process ran nothing, so no request it was
  // handed can have had an effect and the caller may safely retry one-shot. A
  // host that dies after receiving bytes may have already created a file, so
  // that case must surface instead of being retried.
  child.once('error', (error) => failAclHost(
    host,
    child.pid === undefined ? 'state-acl-host-unavailable' : 'state-acl-failed',
    error,
  ));
  child.once('exit', (code, signal) => failAclHost(
    host,
    child.pid === undefined ? 'state-acl-host-unavailable' : 'state-acl-failed',
    new Error(`the Windows ACL helper host exited (code ${code}, signal ${signal})`),
  ));
  child.stdout.on('data', (chunk) => {
    host.stdout = host.stdout.length === 0 ? chunk : Buffer.concat([host.stdout, chunk]);
    drainAclHost(host);
  });
  child.stderr.on('data', (chunk) => {
    host.stderr = (host.stderr + chunk.toString('utf8')).slice(-4096);
  });
  child.stdin.on('error', (error) => failAclHost(host, 'state-acl-failed', error));
  child.unref();
  setAclHostRef(host, false);
  return host;
}

function aclHostRequest(host, { action, file, source, input }) {
  return new Promise((resolve, reject) => {
    if (host.failure) {
      reject(host.failure);
      return;
    }
    const payload = input ?? Buffer.alloc(0);
    if (payload.length > ACL_TRANSPORT_LIMIT) {
      reject(new PathBoundaryError(
        'state-acl-failed',
        `secure write exceeds the ${ACL_TRANSPORT_LIMIT}-byte transport bound: ${file}`,
      ));
      return;
    }
    host.seq += 1;
    const id = String(host.seq);
    const entry = { id, resolve, reject };
    host.queue.push(entry);
    setAclHostRef(host, true);
    try {
      host.child.stdin.write(encodeAclRequestFrame({ id, action, file, source, payload }));
    } catch (error) {
      // The request never reached the host, so it must leave the queue too —
      // a stale entry would be matched against the NEXT response and turn a
      // failed write into some other file's answer.
      const index = host.queue.indexOf(entry);
      if (index >= 0) host.queue.splice(index, 1);
      failAclHost(host, 'state-acl-failed', error);
      reject(host.failure ?? error);
    }
  });
}

process.once('exit', () => {
  if (aclHost === null) return;
  // Closing stdin is what the host waits on; the kill is the backstop for a host
  // that is wedged inside an ACL call.
  try { aclHost.child.stdin.end(); } catch { /* already closed */ }
  try { aclHost.child.kill(); } catch { /* already gone */ }
});

// A host that keeps dying is worse than no host: each attempt costs a failed
// spawn on top of the one-shot call that follows it. Three consecutive failures
// and this process stops trying.
const ACL_HOST_STRIKES = 3;
let aclHostFailures = 0;

// `write` is the one action that is not safely repeatable: it creates the file
// exclusively, so a host that died after creating it but before answering has
// already had its effect. Every other action either only reads, or re-applies
// the same DACL, so retrying one through a fresh process cannot produce a
// different outcome than retrying it through the same one.
const ACL_REPEATABLE = new Set(['read', 'repair', 'verify', 'write-sids', 'sid', 'copy-acl']);

async function defaultWindowsActionAsync(request) {
  if (aclHostUnavailable || process.env.NOOSPHERE_ACL_NO_HOST) {
    return defaultWindowsAction(request);
  }
  const startedAt = ACL_PROFILE === null ? 0n : process.hrtime.bigint();
  if (aclHost === null) {
    try {
      aclHost = startAclHost();
    } catch (error) {
      // PowerShell could not be started at all. The one-shot path cannot do
      // better, but it is the documented path and produces the historical
      // error, so degrade to it rather than invent a new failure mode here.
      aclHostUnavailable = true;
      return defaultWindowsAction(request);
    }
  }
  try {
    const result = await aclHostRequest(aclHost, request);
    aclHostFailures = 0;
    recordAclCall('host', request.action, startedAt);
    return result;
  } catch (error) {
    recordAclCall('host', request.action, startedAt);
    // A refusal is an answer: state-acl-broad means the DACL really is wrong,
    // and asking a second process the same question would only ask it slower.
    // Only a transport failure is worth repeating.
    if (error.aclTransport !== true) throw error;
    aclHostFailures += 1;
    if (error.code === 'state-acl-host-unavailable' || aclHostFailures >= ACL_HOST_STRIKES) {
      aclHostUnavailable = true;
    }
    // The host never became a process, so nothing it was handed can have run:
    // any action may safely be repeated one-shot. A host that died after
    // receiving the request may already have created the file, so only a
    // repeatable action may be retried.
    if (error.code === 'state-acl-host-unavailable' || ACL_REPEATABLE.has(request.action)) {
      return defaultWindowsAction(request);
    }
    throw error;
  }
}

function defaultWindowsAction({ action, file, source, input }) {
  const startedAt = ACL_PROFILE === null ? 0n : process.hrtime.bigint();
  try {
    return execFileSync(
      'powershell.exe',
      source === undefined
        ? powershellArgs(action, file)
        : powershellArgs(action, file, source),
      {
        input: input ?? undefined,
        encoding: 'buffer',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        maxBuffer: ACL_TRANSPORT_LIMIT,
      },
    );
  } catch (error) {
    const stderr = Buffer.isBuffer(error.stderr) ? error.stderr.toString('utf8') : String(error.stderr ?? '');
    throw aclRefusal(stderr, 'state-acl-failed', error);
  } finally {
    recordAclCall('spawn', action, startedAt);
  }
}

function defaultCopyWindowsAcl(source, destination) {
  const startedAt = ACL_PROFILE === null ? 0n : process.hrtime.bigint();
  try {
    return execFileSync('powershell.exe', powershellArgs('copy-acl', destination, source), {
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      maxBuffer: ACL_TRANSPORT_LIMIT,
    });
  } catch (error) {
    const stderr = Buffer.isBuffer(error.stderr) ? error.stderr.toString('utf8') : String(error.stderr ?? '');
    throw aclRefusal(stderr, 'state-acl-copy-failed', error);
  } finally {
    recordAclCall('spawn', 'copy-acl', startedAt);
  }
}

async function defaultCopyWindowsAclAsync(source, destination) {
  try {
    return await defaultWindowsActionAsync({
      action: 'copy-acl', file: destination, source, input: null,
    });
  } catch (error) {
    // The one-shot path reports a copy failure as state-acl-copy-failed even
    // when the helper could not say why; the host path must not report it as
    // something else just because the transport differs.
    if (error instanceof PathBoundaryError && error.code === 'state-acl-failed') {
      throw new PathBoundaryError('state-acl-copy-failed', error.message, error);
    }
    throw error;
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
