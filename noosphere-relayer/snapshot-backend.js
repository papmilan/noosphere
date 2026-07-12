import { createHash, randomUUID } from 'node:crypto';
import { access, chmod, constants, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SNAPSHOT_ID = /^sha256:[0-9a-f]{64}$/;

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

  async put(projectId, snapshotId, canonicalBytes) {
    const bytes = Buffer.from(canonicalBytes);
    const target = this.pathFor(projectId, snapshotId);
    const previous = this.writes.get(target) || Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      const existing = await readFile(target).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
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
    return readFile(this.pathFor(projectId, snapshotId)).catch((error) => {
      if (error.code === 'ENOENT') throw exactError('snapshot-not-found', 404);
      throw error;
    });
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
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function hash(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
