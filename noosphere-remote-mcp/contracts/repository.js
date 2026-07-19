import { validateCheckpoint, validateProject } from './validation.js';

function assertOwnerScope(ownerScope) {
  if (typeof ownerScope !== 'string' || ownerScope.length < 3 || ownerScope.length > 512) throw new Error('invalid-owner-scope');
}

function key(...values) {
  return values.join('\u0000');
}

export class RepositoryConflictError extends Error {
  constructor(code) {
    super(code);
    this.name = 'RepositoryConflictError';
    this.code = code;
    this.status = 409;
    this.retryable = false;
  }
}

function assertIdempotency({ key: idempotencyKey, requestHash }) {
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 1 || idempotencyKey.length > 128 || typeof requestHash !== 'string' || requestHash.length < 1 || requestHash.length > 512) throw new Error('invalid-idempotency');
}

export class ProjectMemoryRepository {
  async createProject() { throw new Error('repository-method-not-implemented'); }
  async getProject() { throw new Error('repository-method-not-implemented'); }
  async saveCheckpoint() { throw new Error('repository-method-not-implemented'); }
}

export class InMemoryProjectMemoryRepository extends ProjectMemoryRepository {
  #projects = new Map();
  #checkpoints = new Map();
  #projectHeads = new Map();
  #idempotency = new Map();

  async createProject({ ownerScope, project } = {}) {
    assertOwnerScope(ownerScope);
    const value = validateProject(project);
    const storageKey = key(ownerScope, value.id);
    if (this.#projects.has(storageKey)) throw new RepositoryConflictError('project-conflict');
    this.#projects.set(storageKey, value);
    return structuredClone(value);
  }

  async getProject({ ownerScope, projectId } = {}) {
    assertOwnerScope(ownerScope);
    const value = this.#projects.get(key(ownerScope, projectId));
    return value ? structuredClone(value) : null;
  }

  async recordIdempotency({ ownerScope, operation, key: idempotencyKey, requestHash, result } = {}) {
    assertOwnerScope(ownerScope);
    if (typeof operation !== 'string' || !/^[a-z][a-z0-9_]{2,63}$/.test(operation)) throw new Error('invalid-operation');
    assertIdempotency({ key: idempotencyKey, requestHash });
    const storageKey = key(ownerScope, operation, idempotencyKey);
    const prior = this.#idempotency.get(storageKey);
    if (prior) {
      if (prior.requestHash !== requestHash) throw new RepositoryConflictError('idempotency-conflict');
      return { result: structuredClone(prior.result), deduplicated: true };
    }
    // The receipt is written only after all caller validation succeeds. A
    // production port must make this insertion atomic with the domain write.
    this.#idempotency.set(storageKey, { requestHash, result: structuredClone(result) });
    return { result: structuredClone(result), deduplicated: false };
  }

  async saveCheckpoint({ ownerScope, checkpoint, idempotency } = {}) {
    assertOwnerScope(ownerScope);
    const value = validateCheckpoint(checkpoint);
    if (!this.#projects.has(key(ownerScope, value.project_id))) throw new Error('project-not-found');

    const idempotencyKey = key(ownerScope, 'save_checkpoint', idempotency?.key);
    const prior = this.#idempotency.get(idempotencyKey);
    assertIdempotency(idempotency ?? {});
    if (prior) {
      if (prior.requestHash !== idempotency.requestHash) throw new RepositoryConflictError('idempotency-conflict');
      return { checkpoint: structuredClone(prior.result.checkpoint), deduplicated: true };
    }

    const checkpointKey = key(ownerScope, value.id);
    if (this.#checkpoints.has(checkpointKey)) throw new RepositoryConflictError('checkpoint-conflict');
    const headKey = key(ownerScope, value.project_id);
    const headId = this.#projectHeads.get(headKey);
    if (value.revision === 1) {
      if (headId !== undefined) throw new RepositoryConflictError('checkpoint-predecessor-conflict');
    } else {
      const predecessor = this.#checkpoints.get(key(ownerScope, value.previous_checkpoint_id));
      if (!predecessor) throw new RepositoryConflictError('checkpoint-predecessor-not-found');
      if (predecessor.project_id !== value.project_id || headId !== value.previous_checkpoint_id) throw new RepositoryConflictError('checkpoint-predecessor-conflict');
      if (predecessor.revision !== value.revision - 1) throw new RepositoryConflictError('checkpoint-revision-conflict');
    }

    this.#checkpoints.set(checkpointKey, value);
    this.#projectHeads.set(headKey, value.id);
    this.#idempotency.set(idempotencyKey, { requestHash: idempotency.requestHash, result: { checkpoint: value } });
    return { checkpoint: structuredClone(value), deduplicated: false };
  }
}

export const POSTGRESQL_REPOSITORY_CONTRACT = Object.freeze({
  requiredMethods: ['createProject', 'getProject', 'saveCheckpoint', 'findProjects', 'listProjects', 'createSession', 'listSessions', 'getCheckpoint', 'listCheckpoints', 'archiveProject', 'deleteProject', 'exportProject'],
  constraints: ['owner_scope_required', 'strictly_linear_checkpoint_history_v1', 'transactions_for_revision_and_idempotency', 'operation_scoped_idempotency', 'cursor_pagination', 'retention_configuration'],
});
