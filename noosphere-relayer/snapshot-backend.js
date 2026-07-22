import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { access, chmod, constants, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { syncDirectoryPath, syncFilePath } from './durability.js';
import { ensureContainedDir } from './secure-fs.js';

const SNAPSHOT_ID = /^sha256:[0-9a-f]{64}$/;
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

// Read a snapshot file without following a final-component symlink. Returns a
// Buffer, null on ENOENT, or throws a fail-closed error if the path is a symlink
// (an attacker-planted link must never redirect a read outside the root).
function readSnapshotNoFollow(target) {
  let fd;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    if (error.code === 'ELOOP') throw exactError('snapshot-path-symlink', 409);
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export class SnapshotBackend {
  async put() { throw new Error('not-implemented'); }
  async get() { throw new Error('not-implemented'); }
  async health() { throw new Error('not-implemented'); }
}

export class FileSnapshotBackend extends SnapshotBackend {
  constructor({ root, shared = false }) {
    super();
    this.root = root;
    this.shared = shared;
    this.writes = new Map();
  }

  pathFor(projectId, snapshotId) {
    assertCanonicalId(snapshotId);
    return path.join(this.root, hash(String(projectId)), `${hash(snapshotId)}.json`);
  }

  // SEC-03: create (and thereby validate) the per-project subdirectory through
  // the secure boundary. ensureContainedDir refuses any symlinked path component
  // under the root and realpath-verifies containment, so a pre-planted symlink
  // (e.g. root/<hash(projectId)> -> outside) cannot redirect the write. IDs are
  // already hashed hex, so no component can carry `..` or a separator.
  async ensureContainedDirFor(target) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await ensureContainedDir(this.root, path.dirname(target), { mode: 0o700 });
  }

  async put(projectId, snapshotId, canonicalBytes) {
    const bytes = Buffer.from(canonicalBytes);
    const target = this.pathFor(projectId, snapshotId);
    const previous = this.writes.get(target) || Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      await this.ensureContainedDirFor(target);
      const existing = readSnapshotNoFollow(target);
      if (existing && !existing.equals(bytes)) throw exactError('snapshot-integrity-conflict');
      if (!existing) await atomicOwnerOnlyWrite(target, bytes);
      return { backend: 'file', locator: snapshotId, bytes: bytes.length };
    });
    this.writes.set(target, operation);
    try { return await operation; } finally {
      if (this.writes.get(target) === operation) this.writes.delete(target);
    }
  }

  async get(projectId, snapshotId) {
    const target = this.pathFor(projectId, snapshotId);
    await this.ensureContainedDirFor(target);
    const bytes = readSnapshotNoFollow(target);
    if (bytes === null) throw exactError('snapshot-not-found', 404);
    return bytes;
  }

  async health() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await access(this.root, constants.R_OK | constants.W_OK);
    return { ready: true, durable: true, shared: this.shared, backend: 'file' };
  }
}

export function assertCanonicalId(snapshotId) {
  if (!SNAPSHOT_ID.test(snapshotId)) throw exactError('invalid-snapshot-id', 400);
}

export function exactError(code, status = 409, details) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  if (details !== undefined) error.details = details;
  return error;
}

async function atomicOwnerOnlyWrite(target, bytes) {
  // SEC-03: the per-project directory was already created and symlink-validated by
  // ensureContainedDirFor() in the only caller (put), so a second recursive mkdir
  // here is dead — and a follow-prone one that only widens the TOCTOU window. The
  // O_EXCL ('wx') temp create plus a rename that replaces (never follows) the final
  // link keep the write contained.
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await syncFilePath(temporary);
    await rename(temporary, target);
    await syncDirectoryPath(path.dirname(target));
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}


function hash(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
