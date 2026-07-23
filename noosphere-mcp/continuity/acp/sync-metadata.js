import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize } from '@noosphere/acp-protocol';
import { RECONCILIATION_POLICY_VERSION, SYNC_PROTOCOL_VERSION } from '@noosphere/acp-protocol';
import { syncDirectoryPath } from './durability.js';
import { atomicOwnerOnlyWrite, readOwnerOnlyFile } from '../secure-fs.js';

const METADATA_FILE = 'continuity-sync.json';
const CONFIRMATION_LIMIT = 16;
const CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const SNAPSHOT_ID = /^sha256:[0-9a-f]{64}$/;
const OBSERVATION_KEYS = [
  'action', 'allow_stale_advanced', 'local_snapshot_id', 'reconciliation_policy_version',
  'relayer_index_id', 'remote_expires_at', 'remote_heads_digest', 'remote_snapshot_id',
  'repository_observation', 'sync_protocol_version',
];
const REPOSITORY_KEYS = ['ancestors', 'branch', 'dirty', 'head', 'root_identity', 'workspace_fingerprint'];
const CONFIRMATION_ACTIONS = new Set(['fast-forward-local', 'remote-only-restore', 'historical-advanced']);

export async function readSyncMetadata(root, options = {}) {
  const file = metadataPath(root);
  try {
    const bytes = await readOwnerOnlyFile(file, secureOptions(root, options));
    if (bytes === null) return normalizeMetadata();
    const parsed = JSON.parse(bytes.toString('utf8'));
    return normalizeMetadata(parsed);
  } catch (error) {
    if (error.code === 'ENOENT') return normalizeMetadata();
    throw syncError('sync-metadata-invalid', error);
  }
}

export async function writeSyncMetadata(root, metadata, options = {}) {
  return mutateSyncMetadata(root, (current) => {
    for (const key of Object.keys(current)) delete current[key];
    Object.assign(current, structuredClone(metadata));
  }, options);
}

export async function mutateSyncMetadata(root, mutation, options = {}) {
  return withMetadataLock(root, async () => {
    const metadata = await readSyncMetadata(root, options);
    const result = await mutation(metadata);
    await writeSyncMetadataUnlocked(root, metadata, options);
    return result;
  });
}

export function withUploadReservationLock(root, operation) {
  return withOwnerLock(root, 'continuity-upload.lock', 'upload-lock-timeout', operation);
}

async function writeSyncMetadataUnlocked(root, metadata, options = {}) {
  const file = metadataPath(root);
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  await atomicOwnerOnlyWrite(
    file,
    `${JSON.stringify(normalizeMetadata(metadata), null, 2)}\n`,
    secureOptions(root, options),
  );
  await syncDirectoryPath(dir);
}

export function digestRepositoryObservation(observed) {
  return digest(canonicalize({
    root_identity: observed.root_identity,
    head: observed.head,
    branch: observed.branch,
    dirty: observed.dirty,
    workspace_fingerprint: observed.workspace_fingerprint,
    ancestors: [...observed.ancestors].sort(),
  }));
}

export async function issueConfirmation(root, observation, clock = Date.now()) {
  validateObservation(observation);
  const now = clockMs(clock);
  return mutateSyncMetadata(root, (metadata) => {
    pruneConfirmations(metadata.confirmations, now);
    if (Object.keys(metadata.confirmations).length >= CONFIRMATION_LIMIT) {
      throw syncError('confirmation-limit');
    }
    const remoteExpiry = observation.remote_expires_at == null
      ? Number.POSITIVE_INFINITY : Date.parse(observation.remote_expires_at);
    const expires = Math.min(now + CONFIRMATION_TTL_MS, remoteExpiry);
    if (!Number.isFinite(expires) || expires <= now) {
      if (remoteExpiry !== Number.POSITIVE_INFINITY) throw syncError('confirmation-expired');
    }
    const body = {
      remote_snapshot_id: observation.remote_snapshot_id,
      local_snapshot_id: observation.local_snapshot_id ?? null,
      remote_heads_digest: observation.remote_heads_digest,
      repository_observation_digest: digestRepositoryObservation(observation.repository_observation),
      relayer_index_id: observation.relayer_index_id,
      sync_protocol_version: observation.sync_protocol_version,
      reconciliation_policy_version: observation.reconciliation_policy_version,
      action: observation.action,
      allow_stale_advanced: observation.allow_stale_advanced === true,
      issued_at: new Date(now).toISOString(),
      expires_at: new Date(Number.isFinite(expires) ? expires : now + CONFIRMATION_TTL_MS).toISOString(),
    };
    const confirmationDigest = digest(canonicalize(body));
    const confirmation = { ...body, confirmation_id: confirmationDigest, digest: confirmationDigest };
    metadata.confirmations[confirmation.confirmation_id] = confirmation;
    return structuredClone(confirmation);
  });
}

export async function consumeConfirmation(root, confirmationId, clock = Date.now()) {
  const confirmation = await mutateSyncMetadata(root, (metadata) => {
    const found = metadata.confirmations[confirmationId];
    if (!found) throw syncError('confirmation-missing');
    delete metadata.confirmations[confirmationId];
    return structuredClone(found);
  });
  try { validateConfirmation(confirmation); } catch { throw syncError('confirmation-invalid'); }
  const { confirmation_id, digest: storedDigest, ...body } = confirmation;
  const expected = digest(canonicalize(body));
  if (confirmation_id !== confirmationId || storedDigest !== expected || confirmation_id !== expected) {
    throw syncError('confirmation-invalid');
  }
  if (Date.parse(confirmation.expires_at) <= clockMs(clock)) throw syncError('confirmation-expired');
  return structuredClone(confirmation);
}

export async function quarantineBytes(root, receivedSnapshotId, receivedBytes, options = {}) {
  const bytes = Buffer.from(receivedBytes);
  const noosphere = path.join(root, '.noosphere');
  const directory = path.join(noosphere, 'quarantine');
  const existingNoosphere = await lstat(noosphere).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (existingNoosphere?.isSymbolicLink() || (existingNoosphere && !existingNoosphere.isDirectory())) {
    throw syncError('quarantine-symlink');
  }
  if (!existingNoosphere) await mkdir(noosphere, { recursive: true, mode: 0o700 });
  await chmod(noosphere, 0o700);
  const existingDirectory = await lstat(directory).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (existingDirectory?.isSymbolicLink()) throw syncError('quarantine-symlink');
  if (existingDirectory && !existingDirectory.isDirectory()) throw syncError('quarantine-symlink');
  if (!existingDirectory) await mkdir(directory, { mode: 0o700 });
  await chmod(directory, 0o700);
  const identity = await lstat(directory);
  const safeId = SNAPSHOT_ID.test(receivedSnapshotId) ? receivedSnapshotId.slice(7) : hashHex(bytes);
  const filename = `sha256-${safeId}.json`;
  await options.beforeSpawn?.(directory);
  await runQuarantineWriter(directory, filename, identity, bytes);
  const after = await lstat(directory).catch(() => null);
  if (!after || after.dev !== identity.dev || after.ino !== identity.ino) throw syncError('quarantine-directory-mismatch');
  return {
    path: path.join(directory, filename),
    snapshot_id: SNAPSHOT_ID.test(receivedSnapshotId) ? receivedSnapshotId : null,
  };
}

function normalizeMetadata(value = {}) {
  return {
    version: 1,
    ...structuredClone(value),
    confirmations: { ...(value.confirmations || {}) },
  };
}

function pruneConfirmations(confirmations, now) {
  for (const [id, confirmation] of Object.entries(confirmations)) {
    if (Date.parse(confirmation.expires_at) <= now) delete confirmations[id];
  }
}

function validateObservation(value) {
  if (!plainObject(value) || !exactKeys(value, OBSERVATION_KEYS)) throw syncError('confirmation-schema');
  if (!SNAPSHOT_ID.test(value.remote_snapshot_id)
    || !(value.local_snapshot_id === null || SNAPSHOT_ID.test(value.local_snapshot_id))
    || !SNAPSHOT_ID.test(value.remote_heads_digest)
    || !SNAPSHOT_ID.test(value.relayer_index_id)
    || value.sync_protocol_version !== SYNC_PROTOCOL_VERSION
    || value.reconciliation_policy_version !== RECONCILIATION_POLICY_VERSION
    || !CONFIRMATION_ACTIONS.has(value.action)
    || typeof value.allow_stale_advanced !== 'boolean'
    || !(value.remote_expires_at === null || validTimestamp(value.remote_expires_at))) {
    throw syncError('confirmation-schema');
  }
  const observed = value.repository_observation;
  if (!plainObject(observed) || !exactKeys(observed, REPOSITORY_KEYS)
    || !SNAPSHOT_ID.test(observed.root_identity)
    || !SNAPSHOT_ID.test(observed.workspace_fingerprint)
    || !(observed.head === null || nonemptyString(observed.head))
    || !(observed.branch === null || nonemptyString(observed.branch))
    || typeof observed.dirty !== 'boolean'
    || !Array.isArray(observed.ancestors)
    || observed.ancestors.some((ancestor) => !nonemptyString(ancestor))) {
    throw syncError('confirmation-schema');
  }
}

function validateConfirmation(value) {
  const keys = [...OBSERVATION_KEYS.filter((key) => !['repository_observation', 'remote_expires_at'].includes(key)),
    'repository_observation_digest', 'issued_at', 'expires_at', 'confirmation_id', 'digest'].sort();
  if (!plainObject(value) || !exactKeys(value, keys)
    || !SNAPSHOT_ID.test(value.remote_snapshot_id)
    || !(value.local_snapshot_id === null || SNAPSHOT_ID.test(value.local_snapshot_id))
    || !SNAPSHOT_ID.test(value.remote_heads_digest)
    || !SNAPSHOT_ID.test(value.repository_observation_digest)
    || !SNAPSHOT_ID.test(value.relayer_index_id)
    || value.sync_protocol_version !== SYNC_PROTOCOL_VERSION
    || value.reconciliation_policy_version !== RECONCILIATION_POLICY_VERSION
    || !CONFIRMATION_ACTIONS.has(value.action)
    || typeof value.allow_stale_advanced !== 'boolean'
    || !validTimestamp(value.issued_at) || !validTimestamp(value.expires_at)
    || Date.parse(value.expires_at) > Date.parse(value.issued_at) + CONFIRMATION_TTL_MS
    || !SNAPSHOT_ID.test(value.confirmation_id) || !SNAPSHOT_ID.test(value.digest)) {
    throw syncError('confirmation-schema');
  }
}

async function withMetadataLock(root, operation) {
  return withOwnerLock(root, 'continuity-sync.lock', 'confirmation-lock-timeout', operation);
}

async function withOwnerLock(root, filename, timeoutCode, operation) {
  const directory = path.join(root, '.noosphere');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const lockPath = path.join(directory, filename);
  const token = randomUUID();
  let handle;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, created_at: Date.now() }));
      await handle.sync();
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await staleLock(lockPath)) await rm(lockPath, { force: true });
      else await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (!handle) throw syncError(timeoutCode);
  try { return await operation(); } finally {
    await handle.close();
    const current = await readFile(lockPath, 'utf8').then(JSON.parse).catch(() => null);
    if (current?.token === token) await rm(lockPath, { force: true });
  }
}

async function staleLock(lockPath) {
  const lock = await readFile(lockPath, 'utf8').then(JSON.parse).catch(() => null);
  if (!lock || !Number.isInteger(lock.pid) || typeof lock.token !== 'string') {
    const details = await lstat(lockPath).catch(() => null);
    return details !== null && Date.now() - details.mtimeMs > 60_000;
  }
  try { process.kill(lock.pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

async function runQuarantineWriter(directory, filename, identity, bytes) {
  const helper = fileURLToPath(new URL('./quarantine-writer.js', import.meta.url));
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper, filename, String(identity.dev), String(identity.ino)], {
      cwd: directory,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { if (stderr.length < 4096) stderr += chunk; });
    child.on('error', (error) => reject(syncError('quarantine-writer-failed', error)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else {
        const known = stderr.match(/quarantine-(?:directory-mismatch|symlink|exists|too-large|writer-failed)/)?.[0];
        reject(syncError(known || 'quarantine-writer-failed'));
      }
    });
    child.stdin.end(bytes);
  });
}

function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function exactKeys(value, keys) { return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()); }
function nonemptyString(value) { return typeof value === 'string' && value.length > 0 && value.length <= 4000; }
function validTimestamp(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)); }

function metadataPath(root) { return path.join(root, '.noosphere', METADATA_FILE); }
function hashHex(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function digest(value) { return `sha256:${hashHex(Buffer.from(value, 'utf8'))}`; }
function clockMs(clock) { return typeof clock === 'function' ? clockMs(clock()) : typeof clock === 'string' ? Date.parse(clock) : Number(clock); }
function syncError(code, cause) { return Object.assign(new Error(code, { cause }), { code }); }

function secureOptions(root, options = {}) {
  return { ...(options.secureFileOptions || {}), root };
}
