import os from 'node:os';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { TextDecoder } from 'node:util';

import { InMemoryProjectMemoryRepository } from '@noosphere/remote-mcp-contracts/index.js';
import {
  acquireOwnerOnlyLock,
  atomicOwnerOnlyWrite,
  readBoundedRegularFile,
  readOwnerOnlyFile,
  tryAcquireOwnerProcessGuard,
} from '@noosphere/secure-fs';

// Local STDIO mode is single-user, so the store lives beside the owner's other
// Noosphere state rather than in the project directory: an MCP host may be
// launched from anywhere, and memory belongs to the owner, not the cwd.
export const DEFAULT_STATE_FILE = path.join(os.homedir(), '.noosphere', 'local-mcp', 'project-memory.json');
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const LOCAL_LOCK_MAX_BYTES = 4096;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function readLocalLock(file) {
  let bytes;
  try {
    bytes = await readBoundedRegularFile(file, {
      root: path.dirname(file),
      maxBytes: LOCAL_LOCK_MAX_BYTES,
    });
  } catch {
    return Object.freeze({ kind: 'unsafe', record: null });
  }
  if (bytes === null) return Object.freeze({ kind: 'missing', record: null });
  try {
    const record = JSON.parse(UTF8.decode(bytes));
    if (
      record === null ||
      Array.isArray(record) ||
      typeof record !== 'object' ||
      !Number.isInteger(record.pid) ||
      record.pid <= 0 ||
      typeof record.token !== 'string' ||
      !UUID_V4.test(record.token) ||
      typeof record.purpose !== 'string'
    ) {
      return Object.freeze({ kind: 'malformed', record: null });
    }
    return Object.freeze({ kind: 'valid', record });
  } catch {
    return Object.freeze({ kind: 'malformed', record: null });
  }
}

async function staleLocalLock(file, purpose) {
  const observed = await readLocalLock(file);
  if (observed.kind !== 'valid' || observed.record.purpose !== purpose) return false;
  return !processIsAlive(observed.record.pid);
}

// A durable repository for Local STDIO mode. All validation, conflict
// detection, and idempotency behaviour is inherited unchanged from the
// in-memory implementation — this class only adds load-on-open and
// write-after-mutation, so local and remote observably agree.
//
// Reads and writes go through the secure-fs owner-only boundary (SEC-03): the
// file is created 0600 inside a 0700 directory, symlinked paths are refused,
// and the write is a temp-file + atomic rename, so a crash mid-write cannot
// leave a torn store.
export class FileProjectMemoryRepository extends InMemoryProjectMemoryRepository {
  #file;
  #lockFile;
  #lockAttempts;
  #lockBackoffMs;
  #writeChain = Promise.resolve();

  constructor({
    file = DEFAULT_STATE_FILE,
    lockAttempts = 500,
    lockBackoffMs = 10,
  } = {}) {
    super();
    if (!Number.isInteger(lockAttempts) || lockAttempts < 1) throw new Error('invalid-lock-attempts');
    if (!Number.isInteger(lockBackoffMs) || lockBackoffMs < 0) throw new Error('invalid-lock-backoff');
    this.#file = path.resolve(file);
    this.#lockFile = `${this.#file}.lock`;
    this.#lockAttempts = lockAttempts;
    this.#lockBackoffMs = lockBackoffMs;
  }

  get file() { return this.#file; }

  // Construct and load in one step; a missing file is a first run, not an error.
  static async open(options = {}) {
    const repository = new FileProjectMemoryRepository(options);
    await repository.load();
    return repository;
  }

  async load() {
    const bytes = await readOwnerOnlyFile(this.#file);
    if (bytes === null) {
      this.restore({});
      return;
    }
    let text;
    try {
      text = UTF8.decode(bytes);
    } catch (cause) {
      throw Object.assign(new Error('local-store-invalid-utf8', { cause }), { code: 'local-store-invalid-utf8' });
    }
    this.restore(JSON.parse(text));
  }

  // Rewrites the whole snapshot per mutation — O(state) per write, which is
  // acceptable at owner-local scale. Move to an append-only log if a store ever
  // grows past a few megabytes.
  //
  async flush() {
    await atomicOwnerOnlyWrite(this.#file, JSON.stringify(this.snapshot()));
  }

  async #reclaimMutationLock() {
    const guardFile = `${this.#lockFile}.reclaim`;
    const guard = await tryAcquireOwnerProcessGuard(guardFile, {
      root: path.dirname(this.#file),
    });
    if (guard === null) return false;
    try {
      if (!(await staleLocalLock(
        this.#lockFile,
        'local-project-memory',
      ))) return false;
      await rm(this.#lockFile, { force: true });
      return true;
    } finally {
      await guard.release().catch(() => undefined);
    }
  }

  async #acquireMutationLock() {
    for (let attempt = 1; attempt <= this.#lockAttempts; attempt += 1) {
      try {
        return await acquireOwnerOnlyLock(this.#lockFile, {
          metadata: { pid: process.pid, purpose: 'local-project-memory' },
        });
      } catch (error) {
        if (error.code !== 'trust-lock-busy' || attempt === this.#lockAttempts) throw error;
        if (await this.#reclaimMutationLock()) continue;
        await new Promise((resolve) => setTimeout(resolve, this.#lockBackoffMs));
      }
    }
    throw new Error('local-store-lock-unreachable');
  }

  // Mutations and their durable snapshot are one serialized transaction inside
  // this process. The inherited repository mutates before its Promise resolves;
  // passing an already-started Promise here used to make a failed flush reject
  // the API while leaving the change visible in memory. Capture the durable
  // state first, start the mutation only inside the queue, and restore that
  // snapshot if the atomic write is refused.
  #persist(operation) {
    const mutation = this.#writeChain.then(async () => {
      const lock = await this.#acquireMutationLock();
      let before = this.snapshot();
      try {
        // Another MCP host may have committed since this instance last read the
        // file. Reload while holding the cross-process lock so this mutation is
        // applied to the latest durable snapshot instead of overwriting it.
        await this.load();
        before = this.snapshot();
        const result = await operation();
        await this.flush();
        return result;
      } catch (error) {
        this.restore(before);
        throw error;
      } finally {
        // A failed release must never rewrite or roll back a mutation that was
        // already atomically committed. Surface it as an operational warning;
        // the remaining lock causes later writers to fail closed.
        await lock.release().catch((error) => {
          process.emitWarning(`local project-memory lock release failed (${error.code ?? 'unknown'})`, {
            code: 'NOOSPHERE_LOCAL_STORE_LOCK',
          });
        });
      }
    });
    // A rejected mutation must not poison the queue for later independent
    // writes; its own caller still receives the original rejection.
    this.#writeChain = mutation.then(() => undefined, () => undefined);
    return mutation;
  }

  #read(operation) {
    const read = this.#writeChain.then(async () => {
      await this.load();
      return operation();
    });
    this.#writeChain = read.then(() => undefined, () => undefined);
    return read;
  }

  async createProject(...args) { return this.#persist(() => super.createProject(...args)); }
  async getProject(...args) { return this.#read(() => super.getProject(...args)); }
  async listProjects(...args) { return this.#read(() => super.listProjects(...args)); }
  async replaceProject(...args) { return this.#persist(() => super.replaceProject(...args)); }
  async deleteProject(...args) { return this.#persist(() => super.deleteProject(...args)); }
  async createSession(...args) { return this.#persist(() => super.createSession(...args)); }
  async getSession(...args) { return this.#read(() => super.getSession(...args)); }
  async listSessions(...args) { return this.#read(() => super.listSessions(...args)); }
  async replaceSession(...args) { return this.#persist(() => super.replaceSession(...args)); }
  async getCheckpoint(...args) { return this.#read(() => super.getCheckpoint(...args)); }
  async listCheckpoints(...args) { return this.#read(() => super.listCheckpoints(...args)); }
  async inspectProjectState(...args) { return this.#read(() => super.inspectProjectState(...args)); }
  async recordIdempotency(...args) { return this.#persist(() => super.recordIdempotency(...args)); }
  async saveCheckpoint(...args) { return this.#persist(() => super.saveCheckpoint(...args)); }
}
