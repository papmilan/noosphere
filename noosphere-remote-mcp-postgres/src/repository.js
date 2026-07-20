import {
  ProjectMemoryRepository,
  RepositoryConflictError,
  RepositoryNotFoundError,
  validateCheckpoint,
  validateProject,
  validateSession,
} from '../../noosphere-remote-mcp/index.js';

import { assertOwnerScope, withTransaction } from './pool.js';

// PostgreSQL control-plane implementation of the pure-core repository port.
// Observable behaviour is identical to InMemoryProjectMemoryRepository: same
// validators, same error types/codes, same return shapes. Records are stored
// verbatim as jsonb `document` and returned as parsed objects, so callers see
// exactly what they wrote (deepEqual parity).

const OPERATION = /^[a-z][a-z0-9_]{2,63}$/;

function assertIdempotency({ key, requestHash } = {}) {
  if (typeof key !== 'string' || key.length < 1 || key.length > 128 || typeof requestHash !== 'string' || requestHash.length < 1 || requestHash.length > 512) {
    throw new Error('invalid-idempotency');
  }
}

function assertReceiptProjectId(projectId) {
  if (projectId !== undefined && (typeof projectId !== 'string' || projectId.length < 1 || projectId.length > 128)) {
    throw new Error('invalid-project-id');
  }
}

async function selectOne(runner, text, values) {
  const { rows } = await runner.query(text, values);
  return rows[0] ?? null;
}

export class PostgresProjectMemoryRepository extends ProjectMemoryRepository {
  #pool;

  constructor({ pool } = {}) {
    super();
    if (!pool) throw new Error('postgres-repository-requires-pool');
    this.#pool = pool;
  }

  async createProject({ ownerScope, project } = {}) {
    assertOwnerScope(ownerScope);
    const value = validateProject(project);
    if (value.latest_checkpoint_id !== null) throw new Error('project-checkpoint-head-mismatch');
    try {
      await this.#pool.query('insert into projects (owner_scope, document) values ($1, $2)', [ownerScope, value]);
    } catch (error) {
      if (error.code === '23505') throw new RepositoryConflictError('project-conflict');
      throw error;
    }
    return value;
  }

  async getProject({ ownerScope, projectId } = {}) {
    assertOwnerScope(ownerScope);
    const row = await selectOne(this.#pool, 'select document from projects where owner_scope = $1 and id = $2', [ownerScope, projectId]);
    return row ? row.document : null;
  }

  async listProjects({ ownerScope } = {}) {
    assertOwnerScope(ownerScope);
    const { rows } = await this.#pool.query('select document from projects where owner_scope = $1 order by seq asc', [ownerScope]);
    return rows.map((row) => row.document);
  }

  async replaceProject({ ownerScope, projectId, project } = {}) {
    assertOwnerScope(ownerScope);
    return withTransaction(this.#pool, async (client) => {
      const current = await selectOne(client, 'select document from projects where owner_scope = $1 and id = $2 for update', [ownerScope, projectId]);
      if (!current) throw new RepositoryNotFoundError('project-not-found');
      validateProject(current.document);
      const value = validateProject(project);
      if (value.id !== projectId || current.document.id !== projectId) throw new Error('project-id-mismatch');
      if (value.latest_checkpoint_id !== current.document.latest_checkpoint_id) throw new Error('project-checkpoint-head-mismatch');
      await client.query('update projects set document = $3 where owner_scope = $1 and id = $2', [ownerScope, projectId, value]);
      return value;
    });
  }

  async deleteProject({ ownerScope, projectId } = {}) {
    assertOwnerScope(ownerScope);
    await withTransaction(this.#pool, async (client) => {
      const existing = await selectOne(client, 'select 1 from projects where owner_scope = $1 and id = $2 for update', [ownerScope, projectId]);
      if (!existing) throw new RepositoryNotFoundError('project-not-found');
      await client.query('delete from checkpoints where owner_scope = $1 and project_id = $2', [ownerScope, projectId]);
      await client.query('delete from sessions where owner_scope = $1 and project_id = $2', [ownerScope, projectId]);
      await client.query('delete from idempotency_receipts where owner_scope = $1 and project_id = $2', [ownerScope, projectId]);
      await client.query('delete from projects where owner_scope = $1 and id = $2', [ownerScope, projectId]);
    });
  }

  async createSession({ ownerScope, session } = {}) {
    assertOwnerScope(ownerScope);
    const value = validateSession(session);
    if (value.latest_checkpoint_id !== null) throw new Error('session-checkpoint-head-mismatch');
    const project = await this.getProject({ ownerScope, projectId: value.project_id });
    if (!project) throw new RepositoryNotFoundError('project-not-found');
    validateProject(project);
    try {
      await this.#pool.query('insert into sessions (owner_scope, document) values ($1, $2)', [ownerScope, value]);
    } catch (error) {
      if (error.code === '23505') throw new RepositoryConflictError('session-conflict');
      throw error;
    }
    return value;
  }

  async getSession({ ownerScope, projectId, sessionId } = {}) {
    assertOwnerScope(ownerScope);
    const row = await selectOne(this.#pool, 'select document from sessions where owner_scope = $1 and project_id = $2 and id = $3', [ownerScope, projectId, sessionId]);
    return row ? row.document : null;
  }

  async listSessions({ ownerScope, projectId } = {}) {
    assertOwnerScope(ownerScope);
    const { rows } = await this.#pool.query('select document from sessions where owner_scope = $1 and project_id = $2 order by seq asc', [ownerScope, projectId]);
    return rows.map((row) => row.document);
  }

  async replaceSession({ ownerScope, projectId, sessionId, session } = {}) {
    assertOwnerScope(ownerScope);
    return withTransaction(this.#pool, async (client) => {
      const project = await selectOne(client, 'select document from projects where owner_scope = $1 and id = $2', [ownerScope, projectId]);
      if (!project) throw new RepositoryNotFoundError('project-not-found');
      validateProject(project.document);
      const current = await selectOne(client, 'select document from sessions where owner_scope = $1 and project_id = $2 and id = $3 for update', [ownerScope, projectId, sessionId]);
      if (!current) throw new RepositoryNotFoundError('session-not-found');
      validateSession(current.document);
      const value = validateSession(session);
      if (value.project_id !== projectId) throw new Error('session-project-mismatch');
      if (value.id !== sessionId) throw new Error('session-id-mismatch');
      if (value.latest_checkpoint_id !== current.document.latest_checkpoint_id) throw new Error('session-checkpoint-head-mismatch');
      await client.query('update sessions set document = $4 where owner_scope = $1 and project_id = $2 and id = $3', [ownerScope, projectId, sessionId, value]);
      return value;
    });
  }

  async getCheckpoint({ ownerScope, projectId, checkpointId } = {}) {
    assertOwnerScope(ownerScope);
    const row = await selectOne(this.#pool, 'select document from checkpoints where owner_scope = $1 and project_id = $2 and id = $3', [ownerScope, projectId, checkpointId]);
    return row ? row.document : null;
  }

  async listCheckpoints({ ownerScope, projectId } = {}) {
    assertOwnerScope(ownerScope);
    const { rows } = await this.#pool.query('select document from checkpoints where owner_scope = $1 and project_id = $2 order by seq asc', [ownerScope, projectId]);
    return rows.map((row) => row.document);
  }

  async inspectProjectState({ ownerScope, projectId } = {}) {
    assertOwnerScope(ownerScope);
    const project = await this.getProject({ ownerScope, projectId });
    if (!project) throw new RepositoryNotFoundError('project-not-found');
    return {
      project,
      sessions: await this.listSessions({ ownerScope, projectId }),
      checkpoints: await this.listCheckpoints({ ownerScope, projectId }),
    };
  }

  async recordIdempotency({ ownerScope, operation, key, requestHash, result, projectId } = {}) {
    assertOwnerScope(ownerScope);
    if (typeof operation !== 'string' || !OPERATION.test(operation)) throw new Error('invalid-operation');
    assertIdempotency({ key, requestHash });
    assertReceiptProjectId(projectId);
    return withTransaction(this.#pool, async (client) => {
      const inserted = await selectOne(
        client,
        `insert into idempotency_receipts (owner_scope, operation, idempotency_key, request_hash, result, project_id)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (owner_scope, operation, idempotency_key) do nothing
         returning true as ok`,
        [ownerScope, operation, key, requestHash, result ?? {}, projectId ?? null],
      );
      if (inserted) return { result: result ?? {}, deduplicated: false };
      const prior = await selectOne(client, 'select request_hash, result from idempotency_receipts where owner_scope = $1 and operation = $2 and idempotency_key = $3', [ownerScope, operation, key]);
      if (prior.request_hash !== requestHash) throw new RepositoryConflictError('idempotency-conflict');
      return { result: prior.result, deduplicated: true };
    });
  }

  async saveCheckpoint({ ownerScope, checkpoint, idempotency, project, session } = {}) {
    assertOwnerScope(ownerScope);
    const value = validateCheckpoint(checkpoint);
    assertIdempotency(idempotency ?? {});
    return withTransaction(this.#pool, async (client) => {
      const prior = await selectOne(client, "select request_hash, result from idempotency_receipts where owner_scope = $1 and operation = 'save_checkpoint' and idempotency_key = $2", [ownerScope, idempotency.key]);
      if (prior) {
        if (prior.request_hash !== idempotency.requestHash) throw new RepositoryConflictError('idempotency-conflict');
        return { checkpoint: prior.result.checkpoint, deduplicated: true };
      }

      // Serialize concurrent checkpoint writers on the project head row.
      const currentProject = await selectOne(client, 'select document from projects where owner_scope = $1 and id = $2 for update', [ownerScope, value.project_id]);
      if (!currentProject) throw new RepositoryNotFoundError('project-not-found');
      validateProject(currentProject.document);
      const nextProject = validateProject(project);
      if (nextProject.id !== value.project_id) throw new Error('checkpoint-project-mismatch');
      if (nextProject.latest_checkpoint_id !== value.id) throw new Error('project-checkpoint-head-mismatch');

      if (await selectOne(client, 'select 1 from checkpoints where owner_scope = $1 and project_id = $2 and id = $3', [ownerScope, value.project_id, value.id])) {
        throw new RepositoryConflictError('checkpoint-conflict');
      }
      const headId = currentProject.document.latest_checkpoint_id;
      if (value.revision === 1) {
        if (headId !== null) throw new RepositoryConflictError('checkpoint-predecessor-conflict');
      } else {
        const predecessor = await selectOne(client, 'select document from checkpoints where owner_scope = $1 and project_id = $2 and id = $3', [ownerScope, value.project_id, value.previous_checkpoint_id]);
        if (!predecessor) throw new RepositoryConflictError('checkpoint-predecessor-not-found');
        validateCheckpoint(predecessor.document);
        if (headId !== value.previous_checkpoint_id) throw new RepositoryConflictError('checkpoint-predecessor-conflict');
        if (predecessor.document.revision !== value.revision - 1) throw new RepositoryConflictError('checkpoint-revision-conflict');
      }

      let nextSession = null;
      if (value.session_id === null) {
        if (session !== undefined && session !== null) throw new Error('checkpoint-session-mismatch');
      } else {
        const currentSession = await selectOne(client, 'select document from sessions where owner_scope = $1 and project_id = $2 and id = $3 for update', [ownerScope, value.project_id, value.session_id]);
        if (!currentSession) throw new RepositoryNotFoundError('session-not-found');
        validateSession(currentSession.document);
        nextSession = validateSession(session);
        if (nextSession.project_id !== value.project_id || nextSession.id !== value.session_id) throw new Error('checkpoint-session-mismatch');
        if (nextSession.latest_checkpoint_id !== value.id) throw new Error('session-checkpoint-head-mismatch');
      }

      await client.query('insert into checkpoints (owner_scope, document) values ($1, $2)', [ownerScope, value]);
      await client.query('update projects set document = $3 where owner_scope = $1 and id = $2', [ownerScope, value.project_id, nextProject]);
      if (nextSession) await client.query('update sessions set document = $4 where owner_scope = $1 and project_id = $2 and id = $3', [ownerScope, value.project_id, value.session_id, nextSession]);
      await client.query(
        "insert into idempotency_receipts (owner_scope, operation, idempotency_key, request_hash, result, project_id) values ($1, 'save_checkpoint', $2, $3, $4, $5)",
        [ownerScope, idempotency.key, idempotency.requestHash, { checkpoint: value }, value.project_id],
      );
      return { checkpoint: value, deduplicated: false };
    });
  }
}
