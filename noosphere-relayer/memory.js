import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MEMORY_PREFIX = 'NOOSPHERE_AGENT_MEMORY_V2\n';
const DEFAULT_SERVER_URL =
  'https://relayer-staging.memory.walrus.xyz';
const DEFAULT_NAMESPACE_PREFIX = 'noosphere';
const directory = path.dirname(fileURLToPath(import.meta.url));

export class MemoryStore {
  constructor() {
    this.mode = process.env.DEMO_MODE === 'true' ? 'demo' : 'walrus-memory';
    this.demoMemories = new Map();
    this.demoLoaded = false;
    this.persistDemo = process.env.NODE_ENV !== 'test';
    this.demoPath =
      process.env.LOCAL_MEMORY_PATH ||
      path.join(directory, '.noosphere-local-memory.json');
    this.clientPromise = null;
    this._writeChain = Promise.resolve();
  }

  async health() {
    if (this.mode === 'demo') {
      return {
        ready: true,
        mode: this.mode,
        persistent: this.persistDemo,
      };
    }

    const configured = Boolean(
      process.env.MEMWAL_PRIVATE_KEY && process.env.MEMWAL_ACCOUNT_ID,
    );
    return {
      ready: configured,
      mode: this.mode,
      server_url: process.env.MEMWAL_SERVER_URL || DEFAULT_SERVER_URL,
      configured,
    };
  }

  async remember(projectId, text) {
    const namespace = projectNamespace(projectId);
    if (this.mode === 'demo') {
      await this.loadDemo();
      const memory = {
        id: randomUUID(),
        blob_id: `demo-${randomUUID()}`,
        namespace,
        text,
      };
      const project = this.demoMemories.get(projectId) || [];
      project.push(memory);
      this.demoMemories.set(projectId, project);
      await this.persistDemoMemories();
      return memory;
    }

    const client = await this.getClient();
    return client.rememberAndWait(text, namespace, {
      timeoutMs: Number(process.env.MEMWAL_REMEMBER_TIMEOUT_MS || 120_000),
    });
  }

  async recall(projectId, query, limit = 10) {
    const namespace = projectNamespace(projectId);
    if (this.mode === 'demo') {
      await this.loadDemo();
      const results = (this.demoMemories.get(projectId) || [])
        .slice(-limit)
        .reverse()
        .map((memory, index) => ({
          blob_id: memory.blob_id,
          text: memory.text,
          distance: Math.min(0.99, index * 0.01),
        }));
      return { results, total: results.length };
    }

    const client = await this.getClient();
    return client.recall({ query, limit, namespace });
  }

  async resetDemo() {
    this.demoMemories.clear();
    this.demoLoaded = true;
    await this.persistDemoMemories();
  }

  async getClient() {
    if (!process.env.MEMWAL_PRIVATE_KEY || !process.env.MEMWAL_ACCOUNT_ID) {
      const error = new Error(
        'Walrus Memory is not configured. Set MEMWAL_PRIVATE_KEY and MEMWAL_ACCOUNT_ID, or run npm run demo.',
      );
      error.status = 503;
      throw error;
    }

    if (!this.clientPromise) {
      this.clientPromise = import('@mysten-incubation/memwal').then(
        ({ MemWal }) =>
          MemWal.create({
            key: process.env.MEMWAL_PRIVATE_KEY,
            accountId: process.env.MEMWAL_ACCOUNT_ID,
            serverUrl:
              process.env.MEMWAL_SERVER_URL || DEFAULT_SERVER_URL,
            namespace: DEFAULT_NAMESPACE_PREFIX,
          }),
      );
    }
    return this.clientPromise;
  }

  async loadDemo() {
    if (this.demoLoaded) return;
    this.demoLoaded = true;
    if (!this.persistDemo) return;

    try {
      const stored = JSON.parse(await readFile(this.demoPath, 'utf8'));
      for (const [projectId, memories] of Object.entries(
        stored.projects || {},
      )) {
        this.demoMemories.set(projectId, memories);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`[memory] Could not load local memory: ${error.message}`);
      }
    }
  }

  async persistDemoMemories() {
    if (!this.persistDemo) return;
    this._writeChain = this._writeChain
      .catch(() => undefined)
      .then(() => this._writeDemoToDisk());
    return this._writeChain;
  }

  async _writeDemoToDisk() {
    const temporary = `${this.demoPath}.${randomUUID()}.tmp`;
    await mkdir(path.dirname(this.demoPath), { recursive: true });
    await writeFile(
      temporary,
      `${JSON.stringify(
        { projects: Object.fromEntries(this.demoMemories) },
        null,
        2,
      )}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    await rename(temporary, this.demoPath);
  }
}

export const memoryStore = new MemoryStore();

export function serializeMemory(record) {
  try {
    return `${MEMORY_PREFIX}${JSON.stringify(record)}`;
  } catch (error) {
    const bad = new Error(`Memory record cannot be serialized: ${error.message}`);
    bad.status = 400;
    throw bad;
  }
}

export function parseMemory(text) {
  if (typeof text !== 'string') return null;
  const payload = text.startsWith(MEMORY_PREFIX)
    ? text.slice(MEMORY_PREFIX.length)
    : text;
  try {
    const record = JSON.parse(payload);
    return record?.schema === 'noosphere.agent-memory.v2' ? record : null;
  } catch {
    return null;
  }
}

function projectNamespace(projectId) {
  const prefix =
    process.env.MEMWAL_NAMESPACE_PREFIX || DEFAULT_NAMESPACE_PREFIX;
  const slug = projectId
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return `${prefix}-${slug || 'project'}`;
}
