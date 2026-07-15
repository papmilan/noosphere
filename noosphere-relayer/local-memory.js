import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

export class LocalMemoryStore {
  constructor(env, { defaultPath }) {
    this.memories = new Map();
    this.loaded = false;
    this.persistent = env.NODE_ENV !== 'test';
    this.filePath = env.LOCAL_MEMORY_PATH || defaultPath;
    this.writeChain = Promise.resolve();
  }

  health(mode) {
    return {
      ready: true,
      mode,
      persistent: this.persistent,
      path: this.persistent ? this.filePath : null,
    };
  }

  reload(env, { defaultPath }) {
    const nextPath = env.LOCAL_MEMORY_PATH || defaultPath;
    if (nextPath !== this.filePath) {
      this.filePath = nextPath;
      this.loaded = false;
      this.memories.clear();
    }
    this.persistent = env.NODE_ENV !== 'test';
  }

  async remember(projectId, namespace, text) {
    await this.load();
    const memory = {
      id: randomUUID(),
      blob_id: `local-${randomUUID()}`,
      namespace,
      text,
    };
    const project = this.memories.get(projectId) || [];
    project.push(memory);
    this.memories.set(projectId, project);
    await this.persist();
    return memory;
  }

  async recall(projectId, limit) {
    await this.load();
    const results = (this.memories.get(projectId) || [])
      .slice(-limit)
      .reverse()
      .map((memory, index) => ({
        blob_id: memory.blob_id,
        text: memory.text,
        distance: Math.min(0.99, index * 0.01),
      }));
    return { results, total: results.length };
  }

  async reset() {
    this.memories.clear();
    this.loaded = true;
    await this.persist();
  }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.persistent) return;

    try {
      const stored = JSON.parse(await readFile(this.filePath, 'utf8'));
      for (const [projectId, memories] of Object.entries(
        stored.projects || {},
      )) {
        this.memories.set(projectId, memories);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`[memory] Could not load local memory: ${error.message}`);
      }
    }
  }

  async persist(writeToDisk = () => this.writeToDisk()) {
    if (!this.persistent) return;
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(writeToDisk);
    return this.writeChain;
  }

  async writeToDisk() {
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(
      temporary,
      `${JSON.stringify(
        { projects: Object.fromEntries(this.memories) },
        null,
        2,
      )}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    await rename(temporary, this.filePath);
  }
}
