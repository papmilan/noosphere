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
  #projectsPerOwner;

  // quota.projectsPerOwner is optional; unset means no limit and keeps behaviour
  // identical to the in-memory reference (so the shared parity suite is unaffected).
  constructor({ pool, quota } = {}) {
    super();
    if (!pool) throw new Error('postgres-repository-requires-pool');
    this.#pool = pool;
    this.#projectsPerOwner = Number.isInteger(quota?.projectsPerOwner) ? quota.projectsPerOwner : null;
  }

  async createProject({ ownerScope, project } = {}) {
    assertOwnerScope(ownerScope);
    const value = validateProject(project);
    if (value.latest_checkpoint_id !== null) throw new Error('project-checkpoint-head-mismatch');
    if (this.#projectsPerOwner !== null) {
      return withTransaction(this.#pool, async (client) => {
        // Serialize owner writes so the count/insert quota check has no race.
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [`project-quota:${ownerScope}`]);
        const { rows } = await client.query('select count(*)::int as n from projects where owner_scope = $1', [ownerScope]);
        if (rows[0].n >= this.#projectsPerOwner) throw new RepositoryConflictError('project-quota-exceeded');
        try {
          await client.query('insert into projects (owner_scope, document) values ($1, $2)', [ownerScope, value]);
        } catch (error) {
          if (error.code === '23505') throw new RepositoryConflictError('project-conflict');
          throw error;
        }
        return value;
      });
    }
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
      await client.query('delete from retention_markers where owner_scope = $1 and project_id = $2', [ownerScope, projectId]);
      await client.query('delete from projects where owner_scope = $1 and id = $2', [ownerScope, projectId]);
    });
  }

  async createSession({ ownerScope, session } = {}) {
    assertOwnerScope(ownerScope);
    const value = validateSession(session);
    if (value.latest_checkpoint_id !== null) throw new Error('session-checkpoint-head-mismatch');
    // Lock the project row so a concurrent deleteProject cannot commit between
    // the existence check and the insert and leave an orphan session.
    return withTransaction(this.#pool, async (client) => {
      const project = await selectOne(client, 'select document from projects where owner_scope = $1 and id = $2 for update', [ownerScope, value.project_id]);
      if (!project) throw new RepositoryNotFoundError('project-not-found');
      validateProject(project.document);
      try {
        await client.query('insert into sessions (owner_scope, document) values ($1, $2)', [ownerScope, value]);
      } catch (error) {
        if (error.code === '23505') throw new RepositoryConflictError('session-conflict');
        throw error;
      }
      return value;
    });
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
      // Serialize concurrent checkpoint writers on the project head row BEFORE
      // evaluating the idempotency receipt. This guarantees that a concurrent
      // identical retry blocks here, then reads the winner's committed receipt
      // and replays it (deduplicated) rather than racing past a not-yet-visible
      // receipt and later failing with a spurious checkpoint-conflict.
      const currentProject = await selectOne(client, 'select document from projects where owner_scope = $1 and id = $2 for update', [ownerScope, value.project_id]);
      if (!currentProject) throw new RepositoryNotFoundError('project-not-found');

      const prior = await selectOne(client, "select request_hash, result from idempotency_receipts where owner_scope = $1 and operation = 'save_checkpoint' and idempotency_key = $2", [ownerScope, idempotency.key]);
      if (prior) {
        if (prior.request_hash !== idempotency.requestHash) throw new RepositoryConflictError('idempotency-conflict');
        return { checkpoint: prior.result.checkpoint, deduplicated: true };
      }

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

  // ---- Retention / export / delete jobs (owner-scoped, not part of the port) ----

  // Owner-scoped point-in-time snapshot for a data-export request.
  async exportProject({ ownerScope, projectId } = {}) {
    return this.inspectProjectState({ ownerScope, projectId });
  }

  async setRetentionMarker({ ownerScope, projectId, retainUntil, reason = null } = {}) {
    assertOwnerScope(ownerScope);
    if (typeof retainUntil !== 'string' || retainUntil.length === 0) throw new Error('invalid-retain-until');
    // Lock the project row so a concurrent deleteProject cannot commit between
    // the existence check and the upsert and leave an orphan marker.
    return withTransaction(this.#pool, async (client) => {
      const project = await selectOne(client, 'select 1 from projects where owner_scope = $1 and id = $2 for update', [ownerScope, projectId]);
      if (!project) throw new RepositoryNotFoundError('project-not-found');
      await client.query(
        `insert into retention_markers (owner_scope, project_id, retain_until, reason) values ($1, $2, $3, $4)
         on conflict (owner_scope, project_id) do update set retain_until = excluded.retain_until, reason = excluded.reason`,
        [ownerScope, projectId, retainUntil, reason],
      );
      return { ownerScope, projectId, retainUntil, reason };
    });
  }

  async listExpiredProjects({ ownerScope, now } = {}) {
    assertOwnerScope(ownerScope);
    if (typeof now !== 'string' || now.length === 0) throw new Error('invalid-now');
    const { rows } = await this.#pool.query('select project_id from retention_markers where owner_scope = $1 and retain_until <= $2 order by retain_until asc', [ownerScope, now]);
    return rows.map((row) => row.project_id);
  }

  // Delete job: hard-delete every project whose retention window has elapsed.
  async purgeExpiredProjects({ ownerScope, now } = {}) {
    const expired = await this.listExpiredProjects({ ownerScope, now });
    for (const projectId of expired) {
      await this.deleteProject({ ownerScope, projectId });
      await this.#pool.query('delete from retention_markers where owner_scope = $1 and project_id = $2', [ownerScope, projectId]);
    }
    return expired;
  }
}
