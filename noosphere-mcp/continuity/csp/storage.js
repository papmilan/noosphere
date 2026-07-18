import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { syncDirectoryPath } from '../acp/durability.js';
import { ensureContainedDir, PathBoundaryError } from '../secure-fs.js';
import { validateState } from './validate.js';

const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const execFileAsync = promisify(execFile);
const LOCAL_RUNTIME_EXCLUDES = [
  '.noosphere/runtime-state.json',
  '.noosphere/*.tmp',
  '.noosphere/*.lock',
];
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
    if (Object.hasOwn(parsed, 'version')) {
      throw cspError('csp-schema-invalid', 'CSP state does not match a supported schema', {
        errors: validated.errors,
      });
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
        await link(paths.state, paths.runtime);
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
  let handle;
  try {
    handle = await open(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | NOFOLLOW,
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
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
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function withCspLock(root, operation, options = {}) {
  const paths = cspPaths(root);
  await ensureContainedDir(root, paths.dir);
  const token = randomUUID();
  let handle;
  const openImpl = options.openImpl ?? open;
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
      if (error.code !== 'EEXIST') throw mapNoFollowError(error, paths.lock);
      if (await staleLock(paths.lock)) await rm(paths.lock, { force: true });
      else await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (!handle) throw cspError('csp-lock-timeout', 'Timed out waiting for the CSP transition lock');
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
    const current = await readFile(paths.lock, 'utf8').then(JSON.parse).catch(() => null);
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
  let handle;
  try {
    handle = await open(file, fs.constants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw mapNoFollowError(error, file);
  }
  try {
    const details = await handle.stat();
    if (!details.isFile()) throw cspError('csp-state-not-file', `${file} is not a regular file`);
    return { bytes: await handle.readFile() };
  } finally {
    await handle.close();
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
    await link(detached, file);
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
  const current = await readFile(exclude, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  let lines = current.split(/\r?\n/u);
  if (lines.at(-1) === '') lines.pop();
  if (trackState) lines = lines.filter((line) => line !== '.noosphere/state.json');
  for (const entry of LOCAL_RUNTIME_EXCLUDES) {
    if (!lines.includes(entry)) lines.push(entry);
  }
  const next = `${lines.join('\n')}\n`;
  if (next === current) return;
  await mkdir(path.dirname(exclude), { recursive: true });
  await writeFile(exclude, next, 'utf8');
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
  const lock = await readFile(lockPath, 'utf8').then(JSON.parse).catch(() => null);
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
      await link(temporary, target);
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
    await link(temporary, target);
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
    await link(backup, target);
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
      await link(backup, target);
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
