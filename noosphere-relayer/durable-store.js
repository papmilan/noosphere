import { randomBytes, randomUUID } from 'node:crypto';
import {
  access,
  constants,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { syncDirectoryPath, syncFilePath } from './durability.js';
import { ensureRealDirectoryPath } from './secure-fs.js';

const DEFAULT_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;

export class DurableStore {
  constructor({
    filePath,
    persist = true,
    receiptTtlMs = DEFAULT_RECEIPT_TTL_MS,
    now = () => Date.now(),
    shared = false,
  }) {
    this.filePath = filePath;
    this.persist = persist;
    this.receiptTtlMs = receiptTtlMs;
    this.now = now;
    this.shared = shared;
    this.state = this.emptyState();
    this.loaded = false;
    this.initializationPromise = null;
    this.writeChain = Promise.resolve();
  }

  async initialize() {
    if (this.loaded) return;
    if (this.initializationPromise) return this.initializationPromise;
    this.initializationPromise = this.load();
    return this.initializationPromise;
  }

  async load() {
    if (!this.persist) return;

    try {
      const stored = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (stored?.version === 1) {
        this.state = {
          version: 1,
          receipts: stored.receipts || {},
          pending: stored.pending || {},
          exact_state: stored.exact_state || this.emptyExactState(),
        };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new Error(`Could not load runtime state: ${error.message}`);
      }
    }
    await this.prune();
    this.loaded = true;
  }

  async getReceipt(key) {
    await this.initialize();
    const receipt = this.state.receipts[key];
    if (!receipt) return null;
    if (this.now() - receipt.completedAt > this.receiptTtlMs) {
      delete this.state.receipts[key];
      await this.save();
      return null;
    }
    return receipt.value;
  }

  async getPending(key) {
    await this.initialize();
    return this.state.pending[key] || null;
  }

  async enqueue(key, job) {
    await this.initialize();
    if (!this.state.pending[key]) {
      this.state.pending[key] = {
        ...job,
        key,
        attempts: 0,
        createdAt: this.now(),
        lastError: null,
        nextAttemptAt: null,
      };
      await this.save();
    }
    return this.state.pending[key];
  }

  async reviveStalePending(key, job) {
    await this.initialize();
    return this.enqueueWrite(async () => {
      const current = this.state.pending[key];
      const canRevive = current?.terminal === true
        && current.terminalError?.code === 'stale-heads'
        && current.projectId === job.projectId
        && current.canonicalEnvelope === job.canonicalEnvelope
        && current.expectedHeadsDigest !== job.expectedHeadsDigest;
      if (!canRevive) return { revived: false, pending: structuredClone(current || null) };
      this.state.pending[key] = {
        ...job,
        key,
        attempts: 0,
        createdAt: this.now(),
        lastError: null,
        nextAttemptAt: null,
      };
      if (this.persist) await this.writeState();
      return { revived: true, pending: structuredClone(this.state.pending[key]) };
    });
  }

  async markAttempt(key, error, { nextAttemptAt = null } = {}) {
    await this.initialize();
    const pending = this.state.pending[key];
    if (!pending) return;
    pending.attempts += 1;
    pending.lastAttemptAt = this.now();
    pending.lastError = error?.message || String(error);
    pending.nextAttemptAt = nextAttemptAt;
    await this.save();
    return pending;
  }

  async reschedule(key, nextAttemptAt = null) {
    await this.initialize();
    const pending = this.state.pending[key];
    if (!pending) return null;
    pending.nextAttemptAt = nextAttemptAt;
    await this.save();
    return pending;
  }

  async markTerminal(key, error) {
    await this.initialize();
    const pending = this.state.pending[key];
    if (!pending) return null;
    pending.terminal = true;
    pending.terminalError = {
      code: error?.code || 'exact-state-error',
      status: Number(error?.status) || 500,
    };
    pending.lastError = pending.terminalError.code;
    pending.lastAttemptAt = this.now();
    pending.nextAttemptAt = null;
    await this.save();
    return pending;
  }

  async complete(key, value) {
    await this.initialize();
    delete this.state.pending[key];
    this.state.receipts[key] = {
      value,
      completedAt: this.now(),
    };
    await this.prune();
    await this.save();
  }

  async listPending() {
    await this.initialize();
    return Object.values(this.state.pending);
  }

  async health() {
    await this.initialize();
    if (!this.persist) return { ready: true, durable: false, shared: false };
    await ensureRealDirectoryPath(path.dirname(this.filePath), { mode: 0o700 });
    await access(path.dirname(this.filePath), constants.W_OK);
    return { ready: true, durable: true, shared: this.shared };
  }

  async readExactProject(projectId) {
    await this.initialize();
    return structuredClone(
      this.state.exact_state.projects[projectId] || emptyProjectRecord(),
    );
  }

  async updateExactProject(projectId, mutation) {
    await this.initialize();
    return this.enqueueWrite(async () => {
      const current = structuredClone(
        this.state.exact_state.projects[projectId] || emptyProjectRecord(),
      );
      const next = await mutation(current);
      this.state.exact_state.projects[projectId] = next;
      await this.writeState();
      return structuredClone(next);
    });
  }

  async exactStateIdentity() {
    await this.initialize();
    if (this.persist) await this.enqueueWrite(() => this.writeState());
    return this.state.exact_state.relayer_index_id;
  }

  enqueueWrite(mutation) {
    const result = this.writeChain.catch(() => undefined).then(mutation);
    this.writeChain = result.then(() => undefined, () => undefined);
    return result;
  }

  async prune() {
    const cutoff = this.now() - this.receiptTtlMs;
    for (const [key, receipt] of Object.entries(this.state.receipts)) {
      if (receipt.completedAt < cutoff) delete this.state.receipts[key];
    }
  }

  async save() {
    if (!this.persist) return;
    return this.enqueueWrite(() => this.writeState());
  }

  async writeState() {
    const directory = path.dirname(this.filePath);
    await ensureRealDirectoryPath(directory, { mode: 0o700 });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify(this.state, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    await syncFilePath(temporary);
    await rename(temporary, this.filePath);
    await syncDirectoryPath(path.dirname(this.filePath));
  }

  async clear() {
    this.state = this.emptyState();
    this.loaded = true;
    if (this.persist) {
      await unlink(this.filePath).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }

  emptyExactState() {
    return {
      version: 1,
      relayer_index_id: `sha256:${randomBytes(32).toString('hex')}`,
      projects: {},
    };
  }

  emptyState() {
    return {
      version: 1,
      receipts: {},
      pending: {},
      exact_state: this.emptyExactState(),
    };
  }
}


function emptyProjectRecord() {
  return {
    snapshots: {},
    heads: [],
    heads_digest: null,
    complete: true,
    indexed_bytes: 0,
  };
}

export async function retryOperation(
  operation,
  {
    attempts = 3,
    baseDelayMs = 1_000,
    onFailure = async () => {},
    shouldRetry = () => true,
    delayFor = (_error, attempt) => baseDelayMs * 2 ** (attempt - 1),
    sleep = (delay) =>
      new Promise((resolve) => setTimeout(resolve, delay)),
  } = {},
) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      await onFailure(error, attempt);
      if (attempt < attempts && shouldRetry(error, attempt)) {
        await sleep(delayFor(error, attempt));
      } else {
        break;
      }
    }
  }
  throw lastError;
}
