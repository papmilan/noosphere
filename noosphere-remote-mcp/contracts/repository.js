import { validateCheckpoint, validateProject, validateSession } from './validation.js';

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

function deleteTuple(root, values) {
  const parents = [];
  let current = root;
  for (const component of values.slice(0, -1)) {
    const next = current.get(component);
    if (!(next instanceof Map)) return false;
    parents.push([current, component, next]);
    current = next;
  }
  const deleted = current.delete(values.at(-1));
  if (!deleted) return false;
  for (const [parent, component, child] of parents.reverse()) {
    if (child.size > 0) break;
    parent.delete(component);
  }
  return true;
}

function listTupleValues(root, values) {
  const valuesMap = getTuple(root, values);
  if (!(valuesMap instanceof Map)) return [];
  return [...valuesMap.values()].map((value) => structuredClone(value));
}

function deleteOwnerProjectRecords(root, ownerScope, projectId) {
  deleteTuple(root, [ownerScope, projectId]);
}

function deleteOwnerProjectReceipts(root, ownerScope, projectId) {
  const operations = root.get(ownerScope);
  if (!(operations instanceof Map)) return;
  for (const [operation, receipts] of operations) {
    for (const [idempotencyKey, receipt] of receipts) {
      if (receipt.projectId === projectId) receipts.delete(idempotencyKey);
    }
    if (receipts.size === 0) operations.delete(operation);
  }
  if (operations.size === 0) root.delete(ownerScope);
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

// Typed missing-record signal so callers map not-found without fragile message
// matching (which would otherwise also catch codes like
// `checkpoint-predecessor-not-found`). The message is the machine code, so
// existing message-regex assertions continue to hold.
export class RepositoryNotFoundError extends Error {
  constructor(code) {
    super(code);
    this.name = 'RepositoryNotFoundError';
    this.code = code;
    this.status = 404;
    this.retryable = false;
  }
}

function assertIdempotency({ key: idempotencyKey, requestHash }) {
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 1 || idempotencyKey.length > 128 || typeof requestHash !== 'string' || requestHash.length < 1 || requestHash.length > 512) throw new Error('invalid-idempotency');
}

function assertReceiptProjectId(projectId) {
  if (projectId !== undefined && (typeof projectId !== 'string' || projectId.length < 1 || projectId.length > 128)) throw new Error('invalid-project-id');
}

export class ProjectMemoryRepository {
  async createProject() { throw new Error('repository-method-not-implemented'); }
  async getProject() { throw new Error('repository-method-not-implemented'); }
  async listProjects() { throw new Error('repository-method-not-implemented'); }
  async replaceProject() { throw new Error('repository-method-not-implemented'); }
  async deleteProject() { throw new Error('repository-method-not-implemented'); }
  async createSession() { throw new Error('repository-method-not-implemented'); }
  async getSession() { throw new Error('repository-method-not-implemented'); }
  async listSessions() { throw new Error('repository-method-not-implemented'); }
  async replaceSession() { throw new Error('repository-method-not-implemented'); }
  async getCheckpoint() { throw new Error('repository-method-not-implemented'); }
  async listCheckpoints() { throw new Error('repository-method-not-implemented'); }
  async inspectProjectState() { throw new Error('repository-method-not-implemented'); }
  async recordIdempotency() { throw new Error('repository-method-not-implemented'); }
  async saveCheckpoint() { throw new Error('repository-method-not-implemented'); }
}

export class InMemoryProjectMemoryRepository extends ProjectMemoryRepository {
  #projects = new Map();
  #sessions = new Map();
  #checkpoints = new Map();
  #idempotency = new Map();

  async createProject({ ownerScope, project } = {}) {
    assertOwnerScope(ownerScope);
    const value = validateProject(project);
    if (value.latest_checkpoint_id !== null) throw new Error('project-checkpoint-head-mismatch');
    if (getTuple(this.#projects, [ownerScope, value.id])) throw new RepositoryConflictError('project-conflict');
    setTuple(this.#projects, [ownerScope, value.id], value);
    return structuredClone(value);
  }

  async getProject({ ownerScope, projectId } = {}) {
    assertOwnerScope(ownerScope);
    const value = getTuple(this.#projects, [ownerScope, projectId]);
    return value ? structuredClone(value) : null;
  }

  async listProjects({ ownerScope } = {}) {
    assertOwnerScope(ownerScope);
    return listTupleValues(this.#projects, [ownerScope]);
  }

  async replaceProject({ ownerScope, projectId, project } = {}) {
    assertOwnerScope(ownerScope);
    const current = getTuple(this.#projects, [ownerScope, projectId]);
    if (!current) throw new RepositoryNotFoundError('project-not-found');
    validateProject(current);
    const value = validateProject(project);
    if (value.id !== projectId || current.id !== projectId) throw new Error('project-id-mismatch');
    if (value.latest_checkpoint_id !== current.latest_checkpoint_id) throw new Error('project-checkpoint-head-mismatch');
    setTuple(this.#projects, [ownerScope, projectId], value);
    return structuredClone(value);
  }

  async deleteProject({ ownerScope, projectId } = {}) {
    assertOwnerScope(ownerScope);
    if (!getTuple(this.#projects, [ownerScope, projectId])) throw new RepositoryNotFoundError('project-not-found');
    deleteTuple(this.#projects, [ownerScope, projectId]);
    deleteOwnerProjectRecords(this.#sessions, ownerScope, projectId);
    deleteOwnerProjectRecords(this.#checkpoints, ownerScope, projectId);
    deleteOwnerProjectReceipts(this.#idempotency, ownerScope, projectId);
  }

  async createSession({ ownerScope, session } = {}) {
    assertOwnerScope(ownerScope);
    const value = validateSession(session);
    if (value.latest_checkpoint_id !== null) throw new Error('session-checkpoint-head-mismatch');
    const project = getTuple(this.#projects, [ownerScope, value.project_id]);
    if (!project) throw new RepositoryNotFoundError('project-not-found');
    validateProject(project);
    const tuple = [ownerScope, value.project_id, value.id];
    if (getTuple(this.#sessions, tuple)) throw new RepositoryConflictError('session-conflict');
    setTuple(this.#sessions, tuple, value);
    return structuredClone(value);
  }

  async getSession({ ownerScope, projectId, sessionId } = {}) {
    assertOwnerScope(ownerScope);
    const value = getTuple(this.#sessions, [ownerScope, projectId, sessionId]);
    return value ? structuredClone(value) : null;
  }

  async listSessions({ ownerScope, projectId } = {}) {
    assertOwnerScope(ownerScope);
    return listTupleValues(this.#sessions, [ownerScope, projectId]);
  }

  async replaceSession({ ownerScope, projectId, sessionId, session } = {}) {
    assertOwnerScope(ownerScope);
    const project = getTuple(this.#projects, [ownerScope, projectId]);
    if (!project) throw new RepositoryNotFoundError('project-not-found');
    validateProject(project);
    const current = getTuple(this.#sessions, [ownerScope, projectId, sessionId]);
    if (!current) throw new RepositoryNotFoundError('session-not-found');
    validateSession(current);
    const value = validateSession(session);
    if (value.project_id !== projectId) throw new Error('session-project-mismatch');
    if (value.id !== sessionId) throw new Error('session-id-mismatch');
    if (value.latest_checkpoint_id !== current.latest_checkpoint_id) throw new Error('session-checkpoint-head-mismatch');
    setTuple(this.#sessions, [ownerScope, projectId, sessionId], value);
    return structuredClone(value);
  }

  async getCheckpoint({ ownerScope, projectId, checkpointId } = {}) {
    assertOwnerScope(ownerScope);
    const value = getTuple(this.#checkpoints, [ownerScope, projectId, checkpointId]);
    return value ? structuredClone(value) : null;
  }

  async listCheckpoints({ ownerScope, projectId } = {}) {
    assertOwnerScope(ownerScope);
    return listTupleValues(this.#checkpoints, [ownerScope, projectId]);
  }

  async inspectProjectState({ ownerScope, projectId } = {}) {
    assertOwnerScope(ownerScope);
    const project = getTuple(this.#projects, [ownerScope, projectId]);
    if (!project) throw new RepositoryNotFoundError('project-not-found');
    return {
      project: structuredClone(project),
      sessions: listTupleValues(this.#sessions, [ownerScope, projectId]),
      checkpoints: listTupleValues(this.#checkpoints, [ownerScope, projectId]),
    };
  }

  async recordIdempotency({ ownerScope, operation, key: idempotencyKey, requestHash, result, projectId } = {}) {
    assertOwnerScope(ownerScope);
    if (typeof operation !== 'string' || !/^[a-z][a-z0-9_]{2,63}$/.test(operation)) throw new Error('invalid-operation');
    assertIdempotency({ key: idempotencyKey, requestHash });
    assertReceiptProjectId(projectId);
    const tuple = [ownerScope, operation, idempotencyKey];
    const prior = getTuple(this.#idempotency, tuple);
    if (prior) {
      if (prior.requestHash !== requestHash) throw new RepositoryConflictError('idempotency-conflict');
      return { result: structuredClone(prior.result), deduplicated: true };
    }
    // The receipt is written only after all caller validation succeeds. A
    // production port must make this insertion atomic with the domain write.
    setTuple(this.#idempotency, tuple, { requestHash, result: structuredClone(result), ...(projectId === undefined ? {} : { projectId }) });
    return { result: structuredClone(result), deduplicated: false };
  }

  async saveCheckpoint({ ownerScope, checkpoint, idempotency, project, session } = {}) {
    assertOwnerScope(ownerScope);
    const value = validateCheckpoint(checkpoint);
    assertIdempotency(idempotency ?? {});

    const idempotencyTuple = [ownerScope, 'save_checkpoint', idempotency.key];
    const prior = getTuple(this.#idempotency, idempotencyTuple);
    if (prior) {
      if (prior.requestHash !== idempotency.requestHash) throw new RepositoryConflictError('idempotency-conflict');
      return { checkpoint: structuredClone(prior.result.checkpoint), deduplicated: true };
    }

    const currentProjectValue = getTuple(this.#projects, [ownerScope, value.project_id]);
    if (!currentProjectValue) throw new RepositoryNotFoundError('project-not-found');
    const currentProject = validateProject(currentProjectValue);
    const nextProject = validateProject(project);
    if (nextProject.id !== value.project_id) throw new Error('checkpoint-project-mismatch');
    if (nextProject.latest_checkpoint_id !== value.id) throw new Error('project-checkpoint-head-mismatch');

    const checkpointTuple = [ownerScope, value.project_id, value.id];
    if (getTuple(this.#checkpoints, checkpointTuple)) throw new RepositoryConflictError('checkpoint-conflict');
    const headId = currentProject.latest_checkpoint_id;
    if (value.revision === 1) {
      if (headId !== null) throw new RepositoryConflictError('checkpoint-predecessor-conflict');
    } else {
      const predecessor = getTuple(this.#checkpoints, [ownerScope, value.project_id, value.previous_checkpoint_id]);
      if (!predecessor) throw new RepositoryConflictError('checkpoint-predecessor-not-found');
      validateCheckpoint(predecessor);
      if (headId !== value.previous_checkpoint_id) throw new RepositoryConflictError('checkpoint-predecessor-conflict');
      if (predecessor.revision !== value.revision - 1) throw new RepositoryConflictError('checkpoint-revision-conflict');
    }

    let nextSession = null;
    if (value.session_id === null) {
      if (session !== undefined && session !== null) throw new Error('checkpoint-session-mismatch');
    } else {
      const currentSessionValue = getTuple(this.#sessions, [ownerScope, value.project_id, value.session_id]);
      if (!currentSessionValue) throw new RepositoryNotFoundError('session-not-found');
      validateSession(currentSessionValue);
      nextSession = validateSession(session);
      if (nextSession.project_id !== value.project_id || nextSession.id !== value.session_id) throw new Error('checkpoint-session-mismatch');
      if (nextSession.latest_checkpoint_id !== value.id) throw new Error('session-checkpoint-head-mismatch');
    }

    // Every supplied/current value is validated before these synchronous map
    // writes, which model one transaction in the production repository.
    setTuple(this.#checkpoints, checkpointTuple, value);
    setTuple(this.#projects, [ownerScope, value.project_id], nextProject);
    if (nextSession) setTuple(this.#sessions, [ownerScope, value.project_id, value.session_id], nextSession);
    setTuple(this.#idempotency, idempotencyTuple, {
      requestHash: idempotency.requestHash,
      result: { checkpoint: value },
      projectId: value.project_id,
    });
    return { checkpoint: structuredClone(value), deduplicated: false };
  }
}

export const POSTGRESQL_REPOSITORY_CONTRACT = Object.freeze({
  // Persistence primitives only. Matching, archiving lifecycle, and summaries
  // are orchestrated by ProjectMemoryService on top of these; they are not
  // repository methods.
  requiredMethods: ['createProject', 'getProject', 'saveCheckpoint', 'listProjects', 'replaceProject', 'createSession', 'getSession', 'listSessions', 'replaceSession', 'getCheckpoint', 'listCheckpoints', 'inspectProjectState', 'recordIdempotency', 'deleteProject'],
  constraints: ['owner_scope_required', 'collision_safe_tuple_keys', 'project_latest_checkpoint_is_head_source_of_truth', 'strictly_linear_checkpoint_history_v1', 'transactions_for_revision_and_idempotency', 'operation_scoped_idempotency', 'cursor_pagination', 'retention_configuration'],
});
