import { randomUUID } from 'node:crypto';
import {
  rename,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { PathBoundaryError, ensureRealDirectoryPath, readContainedStateFile } from './secure-fs.js';

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
    if (!this.persistent) {
      this.loaded = true;
      return;
    }

    let raw;
    try {
      // SEC-03: read through the same trust boundary writeToDisk() uses — reject a
      // symlinked directory/file and never follow one outside the root.
      raw = await readContainedStateFile(this.filePath);
    } catch (error) {
      // Boundary violation: fail closed AND stay retryable — do not mark loaded, so
      // every subsequent call keeps rejecting until the hostile path is corrected
      // (matches DurableStore's sticky fail-closed behavior).
      if (error instanceof PathBoundaryError) throw error;
      console.warn(`[memory] Could not load local memory: ${error.message}`);
      this.loaded = true;
      return;
    }
    if (raw !== null) {
      try {
        const stored = JSON.parse(raw);
        for (const [projectId, memories] of Object.entries(
          stored.projects || {},
        )) {
          this.memories.set(projectId, memories);
        }
      } catch (error) {
        console.warn(`[memory] Could not load local memory: ${error.message}`);
      }
    }
    this.loaded = true;
  }

  async persist(writeToDisk = () => this.writeToDisk()) {
    if (!this.persistent) return;
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(writeToDisk);
    return this.writeChain;
  }

  async writeToDisk() {
    const dir = path.dirname(this.filePath);
    await ensureRealDirectoryPath(dir, { mode: 0o700 });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
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
