import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LocalMemoryStore } from './local-memory.js';
import { WalrusMemoryAdapter } from './walrus-memory.js';

const MEMORY_PREFIX = 'NOOSPHERE_AGENT_MEMORY_V2\n';
const DEFAULT_NAMESPACE_PREFIX = 'noosphere';
export const MEMORY_BACKENDS = {
  LOCAL_FILE: 'local-file',
  WALRUS: 'walrus-memory',
};
const directory = path.dirname(fileURLToPath(import.meta.url));
const defaultLocalMemoryPath = path.join(
  directory,
  '.noosphere-local-memory.json',
);

export class MemoryStore {
  constructor(env = process.env) {
    this.mode = resolveMemoryBackend(env);
    this.local = new LocalMemoryStore(env, {
      defaultPath: defaultLocalMemoryPath,
    });
    this.walrus = new WalrusMemoryAdapter(env);
  }

  async health() {
    if (this.mode === MEMORY_BACKENDS.LOCAL_FILE) {
      return this.local.health(this.mode);
    }

    return this.walrus.health();
  }

  async remember(projectId, text) {
    const namespace = projectNamespace(projectId);
    if (this.mode === MEMORY_BACKENDS.LOCAL_FILE) {
      return this.local.remember(projectId, namespace, text);
    }

    return this.walrus.remember(text, namespace);
  }

  async recall(projectId, query, limit = 10) {
    const namespace = projectNamespace(projectId);
    if (this.mode === MEMORY_BACKENDS.LOCAL_FILE) {
      return this.local.recall(projectId, limit);
    }

    return this.walrus.recall(query, limit, namespace);
  }

  async resetLocal() {
    await this.local.reset();
  }

  async resetDemo() {
    await this.resetLocal();
  }

  reloadConfig(env = process.env) {
    const nextMode = resolveMemoryBackend(env);
    this.mode = nextMode;
    this.local.reload(env, { defaultPath: defaultLocalMemoryPath });
    if (nextMode === MEMORY_BACKENDS.WALRUS) {
      this.walrus = new WalrusMemoryAdapter(env);
    }
  }

  reloadRemoteConfig() {
    this.reloadConfig();
  }

  async loadLocal() {
    return this.local.load();
  }

  async persistLocalMemories() {
    return this.local.persist(() => this._writeLocalToDisk());
  }

  async persistDemoMemories() {
    return this.local.persist(() => this._writeDemoToDisk());
  }

  async loadDemo() {
    return this.loadLocal();
  }

  async _writeLocalToDisk() {
    return this.local.writeToDisk();
  }

  async _writeDemoToDisk() {
    return this._writeLocalToDisk();
  }

  get demoMemories() {
    return this.local.memories;
  }

  set demoMemories(value) {
    this.local.memories = value;
  }

  get demoLoaded() {
    return this.local.loaded;
  }

  set demoLoaded(value) {
    this.local.loaded = value;
  }

  get persistDemo() {
    return this.local.persistent;
  }

  set persistDemo(value) {
    this.local.persistent = value;
  }

  get demoPath() {
    return this.local.filePath;
  }

  set demoPath(value) {
    this.local.filePath = value;
  }
}

export const memoryStore = new MemoryStore();

export function resolveMemoryBackend(env = process.env) {
  const explicit = String(env.NOOSPHERE_MEMORY_BACKEND || '')
    .trim()
    .toLowerCase();
  if (explicit) {
    return normalizeMemoryBackend(explicit);
  }
  if (env.DEMO_MODE === 'true') {
    return MEMORY_BACKENDS.LOCAL_FILE;
  }
  return MEMORY_BACKENDS.WALRUS;
}

export function normalizeMemoryBackend(value) {
  switch (String(value || '').trim().toLowerCase()) {
    case 'local':
    case 'local-file':
    case 'file':
      return MEMORY_BACKENDS.LOCAL_FILE;
    case 'walrus':
    case 'walrus-memory':
      return MEMORY_BACKENDS.WALRUS;
    default:
      throw new Error(
        'NOOSPHERE_MEMORY_BACKEND must be "local-file" or "walrus-memory"',
      );
  }
}

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
