import os from 'node:os';
import path from 'node:path';

import { InMemoryProjectMemoryRepository } from '@noosphere/remote-mcp-contracts/index.js';
import { atomicOwnerOnlyWrite, readOwnerOnlyFile } from '@noosphere/secure-fs';

// Local STDIO mode is single-user, so the store lives beside the owner's other
// Noosphere state rather than in the project directory: an MCP host may be
// launched from anywhere, and memory belongs to the owner, not the cwd.
export const DEFAULT_STATE_FILE = path.join(os.homedir(), '.noosphere', 'local-mcp', 'project-memory.json');

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

  constructor({ file = DEFAULT_STATE_FILE } = {}) {
    super();
    this.#file = path.resolve(file);
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
    if (bytes === null) return;
    this.restore(JSON.parse(bytes.toString('utf8')));
  }

  // ponytail: rewrites the whole snapshot per mutation — O(state) per write,
  // which is nothing at single-user local scale. Move to an append-only log if
  // a store ever grows past a few megabytes.
  //
  // ponytail: last-writer-wins across processes. One MCP host spawns one
  // server, which is the normal case; two hosts sharing this file would each
  // hold their own in-memory state and clobber each other. Give each host its
  // own `file`, or add a read-modify-write lock, if that ever becomes real.
  async flush() {
    await atomicOwnerOnlyWrite(this.#file, JSON.stringify(this.snapshot()));
  }

  // Persist only after the inherited mutation resolves: a rejected write leaves
  // both memory and the file untouched.
  async #persist(operation) {
    const result = await operation;
    await this.flush();
    return result;
  }

  async createProject(...args) { return this.#persist(super.createProject(...args)); }
  async replaceProject(...args) { return this.#persist(super.replaceProject(...args)); }
  async deleteProject(...args) { return this.#persist(super.deleteProject(...args)); }
  async createSession(...args) { return this.#persist(super.createSession(...args)); }
  async replaceSession(...args) { return this.#persist(super.replaceSession(...args)); }
  async recordIdempotency(...args) { return this.#persist(super.recordIdempotency(...args)); }
  async saveCheckpoint(...args) { return this.#persist(super.saveCheckpoint(...args)); }
}
