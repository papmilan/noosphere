import { validateCheckpoint, validateProject } from './validation.js';

function assertOwnerScope(ownerScope) {
  if (typeof ownerScope !== 'string' || ownerScope.length < 3 || ownerScope.length > 512) {
    throw new Error('invalid-owner-scope');
  }
}

function key(ownerScope, value) {
  return `${ownerScope}\u0000${value}`;
}

export class ProjectMemoryRepository {
  async createProject() { throw new Error('repository-method-not-implemented'); }
  async getProject() { throw new Error('repository-method-not-implemented'); }
  async saveCheckpoint() { throw new Error('repository-method-not-implemented'); }
}

export class InMemoryProjectMemoryRepository extends ProjectMemoryRepository {
  #projects = new Map();
  #checkpoints = new Map();
  #idempotency = new Map();

  async createProject({ ownerScope, project } = {}) {
    assertOwnerScope(ownerScope);
    const value = validateProject(project);
    const storageKey = key(ownerScope, value.id);
    if (this.#projects.has(storageKey)) throw new Error('project-conflict');
    this.#projects.set(storageKey, value);
    return structuredClone(value);
  }

  async getProject({ ownerScope, projectId } = {}) {
    assertOwnerScope(ownerScope);
    const value = this.#projects.get(key(ownerScope, projectId));
    return value ? structuredClone(value) : null;
  }

  async saveCheckpoint({ ownerScope, checkpoint, idempotency } = {}) {
    assertOwnerScope(ownerScope);
    const value = validateCheckpoint(checkpoint);
    if (!idempotency || typeof idempotency.key !== 'string' || typeof idempotency.requestHash !== 'string') {
      throw new Error('invalid-idempotency');
    }
    if (!this.#projects.has(key(ownerScope, value.project_id))) throw new Error('project-not-found');
    const idempotencyKey = key(ownerScope, idempotency.key);
    const prior = this.#idempotency.get(idempotencyKey);
    if (prior) {
      if (prior.requestHash !== idempotency.requestHash) throw new Error('idempotency-conflict');
      return { checkpoint: structuredClone(prior.checkpoint), deduplicated: true };
    }
    this.#checkpoints.set(key(ownerScope, value.id), value);
    this.#idempotency.set(idempotencyKey, { requestHash: idempotency.requestHash, checkpoint: value });
    return { checkpoint: structuredClone(value), deduplicated: false };
  }
}

export const POSTGRESQL_REPOSITORY_CONTRACT = Object.freeze({
  requiredMethods: ['createProject', 'getProject', 'saveCheckpoint', 'findProjects', 'listProjects', 'createSession', 'listSessions', 'getCheckpoint', 'listCheckpoints', 'archiveProject', 'deleteProject', 'exportProject'],
  constraints: ['owner_scope_required', 'transactions_for_revision_and_idempotency', 'cursor_pagination', 'retention_configuration'],
});
