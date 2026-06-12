import { randomUUID } from 'node:crypto';
import {
  access,
  constants,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;

export class DurableStore {
  constructor({
    filePath,
    persist = true,
    receiptTtlMs = DEFAULT_RECEIPT_TTL_MS,
    now = () => Date.now(),
  }) {
    this.filePath = filePath;
    this.persist = persist;
    this.receiptTtlMs = receiptTtlMs;
    this.now = now;
    this.state = { version: 1, receipts: {}, pending: {} };
    this.loaded = false;
    this.writeChain = Promise.resolve();
  }

  async initialize() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.persist) return;

    try {
      const stored = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (stored?.version === 1) {
        this.state = {
          version: 1,
          receipts: stored.receipts || {},
          pending: stored.pending || {},
        };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new Error(`Could not load runtime state: ${error.message}`);
      }
    }
    await this.prune();
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
    if (!this.persist) return { ready: true, durable: false };
    await mkdir(path.dirname(this.filePath), {
      recursive: true,
      mode: 0o700,
    });
    await access(path.dirname(this.filePath), constants.W_OK);
    return { ready: true, durable: true };
  }

  async prune() {
    const cutoff = this.now() - this.receiptTtlMs;
    for (const [key, receipt] of Object.entries(this.state.receipts)) {
      if (receipt.completedAt < cutoff) delete this.state.receipts[key];
    }
  }

  async save() {
    if (!this.persist) return;
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(() => this.writeState());
    return this.writeChain;
  }

  async writeState() {
    await mkdir(path.dirname(this.filePath), {
      recursive: true,
      mode: 0o700,
    });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify(this.state, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    await rename(temporary, this.filePath);
  }

  async clear() {
    this.state = { version: 1, receipts: {}, pending: {} };
    this.loaded = true;
    if (this.persist) {
      await unlink(this.filePath).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
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
