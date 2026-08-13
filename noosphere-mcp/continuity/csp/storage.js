import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  link,
  mkdir,
  open,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { syncDirectoryPath } from '../acp/durability.js';
import {
  ensureContainedDir,
  PathBoundaryError,
  atomicRepositoryWrite,
  readBoundedRegularFile,
  readOwnerOnlyFile,
  writeOwnerOnlyFileExclusive,
} from '../secure-fs.js';
import { validateState } from './validate.js';

const execFileAsync = promisify(execFile);

// SEC-05 Phase 4B-R4 — bounded, non-blocking lock read.
//
// A lock path lives inside the working tree, so anything that can write there
// can plant a FIFO at it. A bare readFile then blocks forever with no error
// code, which strands the release and stale-check paths this helper serves.
// Locks are small JSON; the shared primitive refuses anything non-regular,
// symlinked, or larger, and never blocks on the open.
const MAX_LOCK_BYTES = 4096;
// One bound and one failure contract for `.git/info/exclude`, shared with
// ensureLocalExcludes in continuity/index.js. Both callers READ the file and
// then write it back, so a present-but-unusable exclude file must abort rather
// than degrade to an empty string — degrading would rewrite the user's excludes
// with only our own entries.
export const MAX_EXCLUDE_BYTES = 1024 * 1024;

async function readLockJson(lockPath) {
  try {
    const raw = await readBoundedRegularFile(lockPath, { maxBytes: MAX_LOCK_BYTES });
    return raw === null ? null : JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
}

const LOCAL_RUNTIME_EXCLUDES = [
  '.noosphere/runtime-state.json',
  // Inferred state is never shared. Committing it would let a clone, import or
  // restore carry someone else's guesses into another project's read path, which
  // is the self-asserting-provenance failure SEC-05 exists to prevent.
  '.noosphere/inferred-state.json',
  // Local telemetry and an unconfirmed draft. Both were gitignored only in the
  // repository they were developed in, so installing the post-commit hook
  // anywhere else left an untracked file in the developer's status output on
  // the very first commit.
  '.noosphere/commit-observations.json',
  '.noosphere/pending-journal.md',
  '.noosphere/*.tmp',
  '.noosphere/*.lock',
];
// Every staged write in this module publishes a file by hard-linking an
// existing source onto a destination that must not already exist. exFAT, FAT32
// and most SMB mounts have no hard links and answer link() with ENOTSUP, which
// leaves CSP persistence completely unusable on an external drive.
//
// linkOrCopy keeps the two properties the call sites depend on — the
// destination ends up holding the source's bytes, and an existing destination
// is refused rather than clobbered — and falls back to an exclusive byte copy
// where links are unavailable.
//
// ponytail: a copy is not inode-identical, so a crash mid-copy can leave a
// short destination where a link would have left none. Every caller removes the
// source only after this resolves, and every recovery path compares digests, so
// a partial file surfaces as a mismatch and never as accepted data.
const LINK_UNSUPPORTED = new Set([
  'ENOTSUP',
  'EOPNOTSUPP',
  'EPERM',
  'EXDEV',
  'EMLINK',
]);

async function linkOrCopy(source, target, linkImpl = link) {
  try {
    await linkImpl(source, target);
    return;
  } catch (error) {
    // EEXIST is a real answer about the destination, not a missing capability.
    if (error.code === 'EEXIST' || !LINK_UNSUPPORTED.has(error.code)) throw error;
  }

  const raw = await readRawFile(source);
  if (raw === null) {
    throw Object.assign(
      new Error(`Refusing to copy a source that disappeared: ${source}`),
      { code: 'ENOENT' },
    );
  }
  try {
    await writeOwnerOnlyFileExclusive(target, raw.bytes);
  } catch (error) {
    // Normalize onto the code every caller's link path already handles.
    if (error.code === 'state-file-exists') {
      throw Object.assign(new Error(error.message), {
        code: 'EEXIST',
        cause: error,
      });
    }
    throw error;
  }
}

const LEGACY_RUNTIME_FIELDS = new Set([
  'baseline',
  'last_checkpoint_fingerprint',
  'pending_checkpoint_fingerprint',
  'last_checkpoint_at',
  'last_blob_id',
  'last_checkpoint_pending',
  'last_workspace_fingerprint',
]);

export function cspPaths(root) {
  const dir = path.join(root, '.noosphere');
  return {
    dir,
    state: path.join(dir, 'state.json'),
    runtime: path.join(dir, 'runtime-state.json'),
    lock: path.join(dir, '.csp-state.lock'),
  };
}

export async function loadState(root) {
  return (await loadStateRecord(root))?.state ?? null;
}

export async function loadStateRecord(root) {
  await migrateLegacyRuntimeState(root);
  return readStateRecord(root);
}

export async function loadRuntimeState(root) {
  await migrateLegacyRuntimeState(root);
  return (await readRuntimeStateRecord(root))?.state ?? {};
}

export async function updateRuntimeState(root, updater) {
  await migrateLegacyRuntimeState(root);
  return withCspLock(root, async () => {
    const current = await readRuntimeStateRecord(root);
    const proposed = await updater(structuredClone(current?.state ?? {}));
    if (!isPlainObject(proposed)) {
      throw cspError('runtime-state-invalid', 'Runtime state must remain a JSON object');
    }
    return writeRuntimeStateAtomic(root, proposed, current?.identity ?? null);
  });
}

export async function migrateLegacyRuntimeState(root, options = {}) {
  await ensureRuntimeStateIgnored(root);
  const paths = cspPaths(root);
  const directory = await inspectDirectory(root, paths.dir);
  if (directory === null) return { migrated: false, reason: 'state-missing' };

  return withCspLock(root, async () => {
    const raw = await readRawFile(paths.state);
    if (raw === null) return { migrated: false, reason: 'state-missing' };
    const parsed = parseJson(raw.bytes);
    const validated = validateState(parsed);
    if (validated.ok) return { migrated: false, reason: 'csp-state-present' };
    if (isPlainObject(parsed) && Object.hasOwn(parsed, 'version')) {
      const split = splitContaminatedState(parsed);
      if (split === null) {
        throw cspError('csp-schema-invalid', 'CSP state does not match a supported schema', {
          errors: validated.errors,
        });
      }
      return migrateContaminatedState(paths, raw, split, options);
    }
    if (!isLegacyRuntimeState(parsed)) {
      throw cspError(
        'state-file-ambiguous',
        'Existing .noosphere/state.json is neither CSP v1 nor recognized legacy runtime telemetry',
      );
    }

    const runtime = await readRawFile(paths.runtime);
    if (runtime === null) {
      await options.beforeMove?.();
      try {
        await linkOrCopy(paths.state, paths.runtime, options.linkImpl);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const racedRuntime = await readRawFile(paths.runtime);
        if (racedRuntime !== null && raw.bytes.equals(racedRuntime.bytes)) {
          await removeLegacySourceIfCurrent(paths, raw.bytes, options);
          await syncDirectoryPath(paths.dir);
          return { migrated: true, reason: 'identical-runtime-retained' };
        }
        throw cspError(
          'runtime-state-migration-conflict',
          'A runtime-state.json destination appeared during migration; refusing to overwrite it',
        );
      }
      try {
        await removeLegacySourceIfCurrent(paths, raw.bytes, options);
      } catch (error) {
        await detachFileIfIdentity(paths, paths.runtime, raw.bytes, 'new runtime destination');
        throw error;
      }
      await syncDirectoryPath(paths.dir);
      return { migrated: true, reason: 'legacy-state-moved' };
    }
    if (!raw.bytes.equals(runtime.bytes)) {
      throw cspError(
        'runtime-state-migration-conflict',
        'Legacy state.json and runtime-state.json differ; refusing to discard either file',
      );
    }
    await removeLegacySourceIfCurrent(paths, raw.bytes, options);
    await syncDirectoryPath(paths.dir);
    return { migrated: true, reason: 'identical-runtime-retained' };
  });
}

// A pre-2.4 writer kept runtime telemetry inside state.json next to the CSP
// fields. That file names version 1 but fails validation on the extra keys, and
// the branch above used to dead-end every CSP command against it with no repair
// path at all — `state restore`, `checkpoint`, `journal` and even `init` all
// refused, so only hand-editing recovered the project.
//
// Split the two halves when the offending keys are exactly the telemetry ones
// this module already knows about and the CSP remainder validates on its own.
// Anything else still refuses rather than guessing at the user's data — a
// hand-written status typo, for instance, is reported, never rewritten.
function splitContaminatedState(parsed) {
  const state = {};
  const telemetry = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (LEGACY_RUNTIME_FIELDS.has(key)) telemetry[key] = value;
    else state[key] = value;
  }
  if (Object.keys(telemetry).length === 0) return null;
  const validated = validateState(state);
  return validated.ok ? { state: validated.state, telemetry } : null;
}

async function migrateContaminatedState(paths, raw, split, options) {
  const telemetryBytes = Buffer.from(
    `${JSON.stringify(split.telemetry, null, 2)}\n`,
    'utf8',
  );
  const runtime = await readRawFile(paths.runtime);
  if (runtime === null) {
    await options.beforeMove?.();
    await writeOwnerOnlyFileExclusive(paths.runtime, telemetryBytes);
  } else if (!runtime.bytes.equals(telemetryBytes)) {
    throw cspError(
      'runtime-state-migration-conflict',
      'Telemetry inside state.json differs from runtime-state.json; refusing to discard either file',
    );
  }

  // Telemetry lands first so a crash between the two writes re-enters this
  // function and finds an identical runtime destination rather than a conflict.
  // rename() replaces state.json atomically and, unlike link(), works on every
  // filesystem Noosphere runs on.
  const stateBytes = Buffer.from(
    `${JSON.stringify(split.state, null, 2)}\n`,
    'utf8',
  );
  const temporary = path.join(
    paths.dir,
    `.state-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    await writeOwnerOnlyFileExclusive(temporary, stateBytes);
    const current = await readRawFile(paths.state);
    if (current === null || !current.bytes.equals(raw.bytes)) {
      throw cspError('csp-write-stale', 'state.json changed during migration');
    }
    await rename(temporary, paths.state);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  await syncDirectoryPath(paths.dir);
  return { migrated: true, reason: 'legacy-telemetry-split' };
}

export async function ensureRuntimeStateIgnored(root) {
  await updateLocalExclude(root, { trackState: false });
}

export async function ensureTrackedStateVisible(root) {
  await updateLocalExclude(root, { trackState: true });
}

export async function readStateRecord(root) {
  const paths = cspPaths(root);
  const directory = await inspectDirectory(root, paths.dir);
  if (directory === null) return null;
  const raw = await readRawFile(paths.state);
  if (raw === null) return null;
  const parsed = parseJson(raw.bytes);
  const validated = validateState(parsed);
  if (!validated.ok) {
    throw cspError('csp-schema-invalid', 'CSP state does not match the v1 schema', {
      errors: validated.errors,
    });
  }
  return {
    state: validated.state,
    identity: digest(raw.bytes),
  };
}

export async function readRuntimeStateRecord(root) {
  const paths = cspPaths(root);
  const directory = await inspectDirectory(root, paths.dir);
  if (directory === null) return null;
  const raw = await readRawFile(paths.runtime);
  if (raw === null) return null;
  const parsed = parseJson(raw.bytes, 'runtime');
  if (!isPlainObject(parsed)) {
    throw cspError('runtime-state-invalid', 'Runtime state must be a JSON object');
  }
  return { state: parsed, identity: digest(raw.bytes) };
}

// Internal persistence primitive. Production callers must go through
// transitionState; this function is exported only for the transition module.
export async function writeStateAtomic(root, state, expectedIdentity, options = {}) {
  const validated = validateState(state);
  if (!validated.ok) {
    throw cspError('csp-schema-invalid', 'Refusing to persist invalid CSP state', {
      errors: validated.errors,
    });
  }
  const bytes = Buffer.from(`${JSON.stringify(validated.state, null, 2)}\n`, 'utf8');
  await writeJsonAtomic(root, cspPaths(root).state, bytes, expectedIdentity, readStateRecord, options);
  return { state: validated.state, identity: digest(bytes) };
}

async function writeRuntimeStateAtomic(root, state, expectedIdentity) {
  const bytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await writeJsonAtomic(root, cspPaths(root).runtime, bytes, expectedIdentity, readRuntimeStateRecord);
  return { state: structuredClone(state), identity: digest(bytes) };
}

async function writeJsonAtomic(root, target, bytes, expectedIdentity, readRecord, options = {}) {
  const paths = cspPaths(root);
  await ensureContainedDir(root, paths.dir);
  const stem = path.basename(target, '.json');
  const temporary = path.join(paths.dir, `.${stem}-${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeOwnerOnlyFileExclusive(temporary, bytes, {
      ...options.secureFileOptions,
      root,
    });
    const current = await readRecord(root);
    if ((current?.identity ?? null) !== expectedIdentity) {
      throw cspError('csp-write-stale', `${path.basename(target)} identity changed before commit`);
    }
    await options.beforeReplace?.();
    const finalCurrent = await readRecord(root);
    if ((finalCurrent?.identity ?? null) !== expectedIdentity) {
      throw cspError('csp-write-stale', `${path.basename(target)} identity changed at commit`);
    }
    await options.afterIdentityCheck?.();
    await replaceWithoutOverwrite(paths, target, temporary, bytes, expectedIdentity);
    await syncDirectoryPath(paths.dir);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

// POSIX answers an exclusive create against an existing lock with EEXIST.
// Windows answers with EPERM or EACCES whenever another handle still holds the
// file — including one already unlinked but pending delete, which is the state
// this module's own release leaves behind for a moment. Treating those as fatal
// turned ordinary contention into a hard failure: `EPERM: operation not
// permitted, open .csp-state.lock`, intermittently, on Windows CI.
function isLockContention(error, platform) {
  if (error.code === 'EEXIST') return true;
  return platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(error.code);
}

export async function withCspLock(root, operation, options = {}) {
  const paths = cspPaths(root);
  await ensureContainedDir(root, paths.dir);
  const token = randomUUID();
  let handle;
  let contention;
  const openImpl = options.openImpl ?? open;
  // Injectable so the Windows contention path is exercisable off Windows,
  // matching NOOSPHERE_TEST_PLATFORM elsewhere in the package.
  const platform = options.platform ?? process.platform;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    let candidate;
    try {
      candidate = await openImpl(paths.lock, 'wx', 0o600);
      try {
        await candidate.writeFile(JSON.stringify({ pid: process.pid, token, created_at: Date.now() }));
        await candidate.sync();
      } catch (error) {
        await candidate.close().catch(() => undefined);
        await rm(paths.lock, { force: true }).catch(() => undefined);
        throw error;
      }
      handle = candidate;
      break;
    } catch (error) {
      if (!isLockContention(error, platform)) throw mapNoFollowError(error, paths.lock);
      contention = error;
      if (await staleLock(paths.lock)) await rm(paths.lock, { force: true }).catch(() => undefined);
      else await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (!handle) {
    // Report the permission error itself rather than a generic timeout when
    // that is what we spent the retries on; an ACL problem and a busy lock are
    // different problems and should not read the same.
    if (contention && contention.code !== 'EEXIST') throw mapNoFollowError(contention, paths.lock);
    throw cspError('csp-lock-timeout', 'Timed out waiting for the CSP transition lock');
  }
  let value;
  let operationError;
  try {
    await recoverInterruptedWrites(paths);
    value = await operation();
  } catch (error) {
    operationError = error;
  }
  let cleanupError;
  try {
    await handle.close();
  } catch (error) {
    cleanupError = error;
  } finally {
    const current = await readLockJson(paths.lock);
    if (current?.token === token) {
      await rm(paths.lock, { force: true }).catch((error) => { cleanupError ??= error; });
    }
  }
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
  return value;
}

async function inspectDirectory(root, dir) {
  const details = await lstat(dir).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (details === null) return null;
  await ensureContainedDir(root, dir);
  return dir;
}

async function readRawFile(file) {
  const entry = await lstat(file).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (entry === null) return null;
  if (entry.isSymbolicLink()) {
    throw new PathBoundaryError('state-file-symlink', `refusing symlinked file: ${file}`);
  }
  try {
    return { bytes: await readOwnerOnlyFile(file) };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw mapNoFollowError(error, file);
  }
}

function parseJson(bytes, kind = 'CSP') {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw cspError(
      kind === 'runtime' ? 'runtime-state-utf8-invalid' : 'csp-utf8-invalid',
      `${kind === 'runtime' ? 'Runtime' : 'CSP'} state is not valid UTF-8`,
      { cause: error },
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw cspError(
      kind === 'runtime' ? 'runtime-state-json-invalid' : 'csp-json-invalid',
      `${kind === 'runtime' ? 'Runtime' : 'CSP'} state is not valid JSON`,
      { cause: error },
    );
  }
}

function isLegacyRuntimeState(value) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => LEGACY_RUNTIME_FIELDS.has(key));
}

async function removeLegacySourceIfCurrent(paths, expectedBytes, options) {
  await options.beforeRemoveDuplicate?.();
  await detachFileIfIdentity(paths, paths.state, expectedBytes, 'legacy state.json');
}

async function detachFileIfIdentity(paths, file, expectedBytes, label) {
  const detached = path.join(
    paths.dir,
    `.${path.basename(file, '.json')}-migration-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    await rename(file, detached);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw cspError('runtime-state-migration-conflict', `${label} disappeared during migration`);
    }
    throw error;
  }
  const moved = await readRawFile(detached);
  if (moved !== null && moved.bytes.equals(expectedBytes)) {
    await rm(detached);
    return;
  }
  try {
    await linkOrCopy(detached, file);
    await rm(detached);
  } catch (restoreError) {
    throw cspError(
      'runtime-state-migration-recovery-required',
      `${label} changed during migration and was preserved at ${detached}`,
      { cause: restoreError, recovery_path: detached },
    );
  }
  throw cspError(
    'runtime-state-migration-conflict',
    `${label} changed during migration; it was restored without being removed`,
  );
}

async function updateLocalExclude(root, { trackState }) {
  const exclude = await gitExcludePath(root);
  if (exclude === null) return;
  // Bounded and non-blocking: .git/info/exclude is repository-controlled.
  const excludeBytes = await readBoundedRegularFile(exclude, { maxBytes: MAX_EXCLUDE_BYTES });
  const current = excludeBytes === null ? '' : excludeBytes.toString('utf8');
  let lines = current.split(/\r?\n/u);
  if (lines.at(-1) === '') lines.pop();
  if (trackState) lines = lines.filter((line) => line !== '.noosphere/state.json');
  for (const entry of LOCAL_RUNTIME_EXCLUDES) {
    if (!lines.includes(entry)) lines.push(entry);
  }
  const next = `${lines.join('\n')}\n`;
  if (next === current) return;
  await mkdir(path.dirname(exclude), { recursive: true });
  // Atomic: continuity/index.js reads this same file, and writeFile's
  // truncate-then-write window publishes it empty first.
  await atomicRepositoryWrite(exclude, next);
}

async function gitExcludePath(root) {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--git-path', 'info/exclude'], {
      cwd: root,
      maxBuffer: 16_384,
    });
    const value = stdout.trim();
    return path.isAbsolute(value) ? value : path.resolve(root, value);
  } catch {
    return null;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function staleLock(lockPath) {
  const lock = await readLockJson(lockPath);
  if (!lock || !Number.isInteger(lock.pid)) {
    const details = await lstat(lockPath).catch(() => null);
    return details !== null && Date.now() - details.mtimeMs > 60_000;
  }
  try {
    process.kill(lock.pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

function mapNoFollowError(error, file) {
  if (error.code === 'ELOOP') {
    return new PathBoundaryError('state-file-symlink', `refusing symlinked file: ${file}`);
  }
  return error;
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function replaceWithoutOverwrite(paths, target, temporary, bytes, expectedIdentity) {
  if (expectedIdentity === null) {
    try {
      await linkOrCopy(temporary, target);
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw cspError('csp-write-stale', `${path.basename(target)} appeared at commit`);
      }
      throw error;
    }
    await rm(temporary);
    return;
  }

  const proposedIdentity = digest(bytes);
  const stem = path.basename(target, '.json');
  const backup = path.join(
    paths.dir,
    `.${stem}-write-backup-${expectedIdentity}-${proposedIdentity}-${randomUUID()}.tmp`,
  );
  try {
    await rename(target, backup);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw cspError('csp-write-stale', `${path.basename(target)} disappeared at commit`);
    }
    throw error;
  }

  const displaced = await readRawFile(backup);
  if (displaced === null || digest(displaced.bytes) !== expectedIdentity) {
    await restoreDisplacedFile(target, backup, `${path.basename(target)} changed at commit`);
    throw cspError('csp-write-stale', `${path.basename(target)} changed at commit`);
  }

  try {
    await linkOrCopy(temporary, target);
  } catch (error) {
    if (error.code === 'EEXIST') {
      await rm(backup);
      throw cspError('csp-write-stale', `${path.basename(target)} reappeared at commit`);
    }
    await restoreDisplacedFile(target, backup, `${path.basename(target)} replacement failed`);
    throw error;
  }
  await rm(temporary);
  await rm(backup);
}

async function restoreDisplacedFile(target, backup, message) {
  try {
    await linkOrCopy(backup, target);
    await rm(backup);
  } catch (error) {
    throw cspError('csp-write-recovery-required', `${message}; preserved displaced data at ${backup}`, {
      cause: error,
      recovery_path: backup,
    });
  }
}

async function recoverInterruptedWrites(paths) {
  const entries = await readdir(paths.dir).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const [stem, target] of [['state', paths.state], ['runtime-state', paths.runtime]]) {
    const prefix = `.${stem}-write-backup-`;
    const backups = entries.filter((entry) => entry.startsWith(prefix) && entry.endsWith('.tmp'));
    if (backups.length > 1) {
      throw cspError(
        'csp-write-recovery-required',
        `Multiple interrupted ${stem} writes require manual recovery`,
        { recovery_paths: backups.map((entry) => path.join(paths.dir, entry)) },
      );
    }
    if (backups.length === 0) continue;
    const backup = path.join(paths.dir, backups[0]);
    const identities = backups[0].slice(prefix.length).split('-');
    const expectedIdentity = identities[0];
    const proposedIdentity = identities[1];
    const [current, displaced] = await Promise.all([readRawFile(target), readRawFile(backup)]);
    const currentIdentity = current === null ? null : digest(current.bytes);
    const displacedIdentity = displaced === null ? null : digest(displaced.bytes);
    if (current === null && displaced !== null) {
      await linkOrCopy(backup, target);
      await rm(backup);
      continue;
    }
    if (displacedIdentity === expectedIdentity && currentIdentity === proposedIdentity) {
      await rm(backup);
      continue;
    }
    throw cspError(
      'csp-write-recovery-required',
      `Interrupted ${stem} write preserved ambiguous data at ${backup}`,
      { recovery_path: backup },
    );
  }
}

function cspError(code, message, details = {}) {
  return Object.assign(new Error(message, { cause: details.cause }), { code }, details);
}
