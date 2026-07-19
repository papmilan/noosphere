import { validateCheckpoint, validateProject } from './validation.js';

function assertOwnerScope(ownerScope) {
  if (typeof ownerScope !== 'string' || ownerScope.length < 3 || ownerScope.length > 512) throw new Error('invalid-owner-scope');
}

function getTuple(root, values) {
  let current = root;
  for (const value of values) {
    current = current.get(value);
    if (current === undefined) return undefined;
  }
  return current;
}

function setTuple(root, values, value) {
  let current = root;
  for (const component of values.slice(0, -1)) {
    let next = current.get(component);
    if (!next) {
      next = new Map();
      current.set(component, next);
    }
    current = next;
  }
  current.set(values.at(-1), value);
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
  #idempotency = new Map();

  async createProject({ ownerScope, project } = {}) {
    assertOwnerScope(ownerScope);
    const value = validateProject(project);
    if (getTuple(this.#projects, [ownerScope, value.id])) throw new RepositoryConflictError('project-conflict');
    setTuple(this.#projects, [ownerScope, value.id], value);
    return structuredClone(value);
  }

  async getProject({ ownerScope, projectId } = {}) {
    assertOwnerScope(ownerScope);
    const value = getTuple(this.#projects, [ownerScope, projectId]);
    return value ? structuredClone(value) : null;
  }

  async recordIdempotency({ ownerScope, operation, key: idempotencyKey, requestHash, result } = {}) {
    assertOwnerScope(ownerScope);
    if (typeof operation !== 'string' || !/^[a-z][a-z0-9_]{2,63}$/.test(operation)) throw new Error('invalid-operation');
    assertIdempotency({ key: idempotencyKey, requestHash });
    const tuple = [ownerScope, operation, idempotencyKey];
    const prior = getTuple(this.#idempotency, tuple);
    if (prior) {
      if (prior.requestHash !== requestHash) throw new RepositoryConflictError('idempotency-conflict');
      return { result: structuredClone(prior.result), deduplicated: true };
    }
    // The receipt is written only after all caller validation succeeds. A
    // production port must make this insertion atomic with the domain write.
    setTuple(this.#idempotency, tuple, { requestHash, result: structuredClone(result) });
    return { result: structuredClone(result), deduplicated: false };
  }

  async saveCheckpoint({ ownerScope, checkpoint, idempotency } = {}) {
    assertOwnerScope(ownerScope);
    const value = validateCheckpoint(checkpoint);
    const project = getTuple(this.#projects, [ownerScope, value.project_id]);
    if (!project) throw new Error('project-not-found');
    assertIdempotency(idempotency ?? {});

    const idempotencyTuple = [ownerScope, 'save_checkpoint', idempotency.key];
    const prior = getTuple(this.#idempotency, idempotencyTuple);
    if (prior) {
      if (prior.requestHash !== idempotency.requestHash) throw new RepositoryConflictError('idempotency-conflict');
      return { checkpoint: structuredClone(prior.result.checkpoint), deduplicated: true };
    }

    if (getTuple(this.#checkpoints, [ownerScope, value.id])) throw new RepositoryConflictError('checkpoint-conflict');
    const headId = project.latest_checkpoint_id;
    if (value.revision === 1) {
      if (headId !== null) throw new RepositoryConflictError('checkpoint-predecessor-conflict');
    } else {
      const predecessor = getTuple(this.#checkpoints, [ownerScope, value.previous_checkpoint_id]);
      if (!predecessor) throw new RepositoryConflictError('checkpoint-predecessor-not-found');
      if (predecessor.project_id !== value.project_id || headId !== value.previous_checkpoint_id) throw new RepositoryConflictError('checkpoint-predecessor-conflict');
      if (predecessor.revision !== value.revision - 1) throw new RepositoryConflictError('checkpoint-revision-conflict');
    }

    // The stored Project is the sole checkpoint-head source. These synchronous
    // map updates model one atomic transaction in the production repository.
    const nextProject = { ...project, latest_checkpoint_id: value.id };
    setTuple(this.#checkpoints, [ownerScope, value.id], value);
    setTuple(this.#projects, [ownerScope, value.project_id], nextProject);
    setTuple(this.#idempotency, idempotencyTuple, { requestHash: idempotency.requestHash, result: { checkpoint: value } });
    return { checkpoint: structuredClone(value), deduplicated: false };
  }
}

export const POSTGRESQL_REPOSITORY_CONTRACT = Object.freeze({
  requiredMethods: ['createProject', 'getProject', 'saveCheckpoint', 'findProjects', 'listProjects', 'createSession', 'listSessions', 'getCheckpoint', 'listCheckpoints', 'archiveProject', 'deleteProject', 'exportProject'],
  constraints: ['owner_scope_required', 'collision_safe_tuple_keys', 'project_latest_checkpoint_is_head_source_of_truth', 'strictly_linear_checkpoint_history_v1', 'transactions_for_revision_and_idempotency', 'operation_scoped_idempotency', 'cursor_pagination', 'retention_configuration'],
});
