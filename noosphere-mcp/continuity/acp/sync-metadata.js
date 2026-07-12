import { createHash, randomUUID } from 'node:crypto';
import {
  chmod, constants, lstat, mkdir, open, readFile, rename, rm, writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { canonicalize } from '@noosphere/acp-protocol';

const METADATA_FILE = 'continuity-sync.json';
const CONFIRMATION_LIMIT = 16;
const CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const SNAPSHOT_ID = /^sha256:[0-9a-f]{64}$/;

export async function readSyncMetadata(root) {
  const file = metadataPath(root);
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    return normalizeMetadata(parsed);
  } catch (error) {
    if (error.code === 'ENOENT') return normalizeMetadata();
    throw syncError('sync-metadata-invalid', error);
  }
}

export async function writeSyncMetadata(root, metadata) {
  const file = metadataPath(root);
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(normalizeMetadata(metadata), null, 2)}\n`, {
      encoding: 'utf8', mode: 0o600, flag: 'wx',
    });
    await syncPath(temporary);
    await rename(temporary, file);
    await chmod(file, 0o600);
    await syncPath(dir);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
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
  const now = clockMs(clock);
  const metadata = await readSyncMetadata(root);
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
  const confirmation = {
    ...body,
    confirmation_id: confirmationDigest,
    digest: confirmationDigest,
  };
  metadata.confirmations[confirmation.confirmation_id] = confirmation;
  await writeSyncMetadata(root, metadata);
  return structuredClone(confirmation);
}

export async function consumeConfirmation(root, confirmationId, clock = Date.now()) {
  const metadata = await readSyncMetadata(root);
  const confirmation = metadata.confirmations[confirmationId];
  if (!confirmation) throw syncError('confirmation-missing');
  delete metadata.confirmations[confirmationId];
  await writeSyncMetadata(root, metadata);
  const { confirmation_id, digest: storedDigest, ...body } = confirmation;
  const expected = digest(canonicalize(body));
  if (confirmation_id !== confirmationId || storedDigest !== expected || confirmation_id !== expected) {
    throw syncError('confirmation-invalid');
  }
  if (Date.parse(confirmation.expires_at) <= clockMs(clock)) throw syncError('confirmation-expired');
  return structuredClone(confirmation);
}

export async function quarantineBytes(root, receivedSnapshotId, receivedBytes) {
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
  const directoryHandle = await open(directory, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    if (!(await directoryHandle.stat()).isDirectory()) throw syncError('quarantine-symlink');
    const safeId = SNAPSHOT_ID.test(receivedSnapshotId) ? receivedSnapshotId.slice(7) : hashHex(bytes);
    const target = path.join(directory, `sha256-${safeId}.json`);
    let handle;
    try {
      handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600);
    } catch (error) {
      if (error.code === 'ELOOP') throw syncError('quarantine-symlink', error);
      if (error.code === 'EEXIST') {
        if ((await lstat(target)).isSymbolicLink()) throw syncError('quarantine-symlink');
        throw syncError('quarantine-exists');
      }
      throw error;
    }
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await directoryHandle.sync();
    return { path: target, snapshot_id: SNAPSHOT_ID.test(receivedSnapshotId) ? receivedSnapshotId : null };
  } finally {
    await directoryHandle.close();
  }
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

function metadataPath(root) { return path.join(root, '.noosphere', METADATA_FILE); }
function hashHex(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function digest(value) { return `sha256:${hashHex(Buffer.from(value, 'utf8'))}`; }
function clockMs(clock) { return typeof clock === 'function' ? clockMs(clock()) : typeof clock === 'string' ? Date.parse(clock) : Number(clock); }
function syncError(code, cause) { return Object.assign(new Error(code, { cause }), { code }); }
async function syncPath(target) { const handle = await open(target, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
