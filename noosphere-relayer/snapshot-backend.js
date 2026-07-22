import { createHash } from 'node:crypto';
import { access, constants, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { syncDirectoryPath } from './durability.js';
import { PathBoundaryError, atomicOwnerOnlyWrite, ensureContainedDir, readOwnerOnlyFile } from './secure-fs.js';

const SNAPSHOT_ID = /^sha256:[0-9a-f]{64}$/;
export class SnapshotBackend {
  async put() { throw new Error('not-implemented'); }
  async get() { throw new Error('not-implemented'); }
  async health() { throw new Error('not-implemented'); }
}

export class FileSnapshotBackend extends SnapshotBackend {
  constructor({ root, shared = false, secureFileOptions = {} }) {
    super();
    this.root = root;
    this.shared = shared;
    this.writes = new Map();
    this.secureFileOptions = secureFileOptions;
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
      const existing = await readSnapshotOwnerOnly(target, this.root, this.secureFileOptions);
      if (existing && !existing.equals(bytes)) throw exactError('snapshot-integrity-conflict');
      if (!existing) {
        await atomicOwnerOnlyWrite(target, bytes, { ...this.secureFileOptions, root: this.root });
        await syncDirectoryPath(path.dirname(target));
      }
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
    const bytes = await readSnapshotOwnerOnly(target, this.root, this.secureFileOptions);
    if (bytes === null) throw exactError('snapshot-not-found', 404);
    return bytes;
  }

  async health() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await access(this.root, constants.R_OK | constants.W_OK);
    return { ready: true, durable: true, shared: this.shared, backend: 'file' };
  }
}

async function readSnapshotOwnerOnly(target, root, secureFileOptions) {
  try {
    return await readOwnerOnlyFile(target, { ...secureFileOptions, root });
  } catch (error) {
    if (error instanceof PathBoundaryError && error.code === 'state-file-symlink') {
      throw exactError('snapshot-path-symlink', 409);
    }
    throw error;
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

function hash(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
