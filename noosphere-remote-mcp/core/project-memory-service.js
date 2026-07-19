import { randomBytes } from 'node:crypto';

import { PROJECT_MEMORY_LIMITS, PROJECT_MEMORY_SCHEMA_VERSION } from '../contracts/constants.js';
import { MCP_ERROR_CODES, createMcpError } from '../contracts/errors.js';
import { assessResumeFreshness } from '../contracts/freshness.js';
import { validateSaveCheckpointInput } from '../contracts/validation.js';
import { normalizeProjectText } from './normalization.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import { requestHash } from './stable-json.js';

const CONTENT_TRUST = 'untrusted-persisted-data';

// A locally committed durable state that violates a checkpoint/session/head
// invariant is treated as untrusted persisted data, never projected.
const INCONSISTENT_WARNING = Object.freeze({
  code: 'repository-state-inconsistent',
  message: 'The durable project state is incomplete and cannot be safely resumed.',
});

const CONFLICT_CODE = new Set([
  'project-conflict',
  'session-conflict',
  'checkpoint-conflict',
  'checkpoint-predecessor-conflict',
  'checkpoint-predecessor-not-found',
  'checkpoint-revision-conflict',
]);

function isPublicError(value) {
  return Boolean(value && typeof value === 'object' && value.isError === true && value.error);
}

// The repository throws plain domain Errors and RepositoryConflictError; the
// service is the trust boundary that converts them into public MCP codes.
function mapRepositoryError(error) {
  if (isPublicError(error)) return error;
  if (error && error.name === 'RepositoryConflictError') {
    if (error.code === 'idempotency-conflict') return createMcpError(MCP_ERROR_CODES.IDEMPOTENCY_CONFLICT);
    if (CONFLICT_CODE.has(error.code)) return createMcpError(MCP_ERROR_CODES.CONFLICT);
    return createMcpError(MCP_ERROR_CODES.CONFLICT);
  }
  const message = typeof error?.message === 'string' ? error.message : '';
  if (/not-found/.test(message)) return createMcpError(MCP_ERROR_CODES.NOT_FOUND);
  return createMcpError(MCP_ERROR_CODES.INVALID_ARGUMENT);
}

function invalidArgument() {
  return createMcpError(MCP_ERROR_CODES.INVALID_ARGUMENT);
}

function assertInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalidArgument();
  return input;
}

function assertText(value, maximum) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) throw invalidArgument();
  return value;
}

function assertId(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{2,127}$/.test(value)) throw invalidArgument();
  return value;
}

function normalize(value) {
  try {
    return normalizeProjectText(value);
  } catch {
    throw invalidArgument();
  }
}

function projectRef(project) {
  return {
    schema_version: PROJECT_MEMORY_SCHEMA_VERSION,
    id: project.id,
    name: project.name,
    status: project.status,
    last_activity_at: project.last_activity_at,
  };
}

// key descending, id ascending — one total order shared by list pagination and
// candidate ranking so cursors and refs stay stable.
function compareByKeyDescIdAsc(a, b) {
  if (a.key < b.key) return 1;
  if (a.key > b.key) return -1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

export class ProjectMemoryService {
  #repository;
  #now;
  #nextId;
  #cursorSecret;

  constructor({ repository, now, nextId, cursorSecret } = {}) {
    if (!repository) throw new Error('project-memory-service-requires-repository');
    this.#repository = repository;
    this.#now = typeof now === 'function' ? now : () => new Date().toISOString();
    this.#nextId = typeof nextId === 'function' ? nextId : (prefix) => `${prefix}_${randomBytes(12).toString('hex')}`;
    // ponytail: per-instance cursor secret is correct for the single-process
    // in-memory core; a shared secret arrives with the transport/deploy PR.
    this.#cursorSecret = cursorSecret ?? randomBytes(32);
  }

  #id(prefix) {
    const value = this.#nextId(prefix);
    return assertId(value);
  }

  async #getProjectOrThrow(ownerScope, projectId) {
    const project = await this.#repository.getProject({ ownerScope, projectId });
    if (!project) throw createMcpError(MCP_ERROR_CODES.NOT_FOUND);
    return project;
  }

  // Owner/query-bound page over an already-sorted collection. `sortKey` maps a
  // record to its primary ordering value; the cursor pins (key,id).
  #paginate({ ownerScope, operation, query, records, cursor, limit, sortKey }) {
    const bounded = Number.isInteger(limit)
      ? Math.min(Math.max(limit, 1), PROJECT_MEMORY_LIMITS.pageSizeMaximum)
      : PROJECT_MEMORY_LIMITS.pageSizeDefault;
    const ordered = records
      .map((record) => ({ record, key: sortKey(record), id: record.id }))
      .sort(compareByKeyDescIdAsc);
    let start = 0;
    if (cursor !== undefined && cursor !== null) {
      let after;
      try {
        ({ after } = decodeCursor(cursor, { ownerScope, operation, query }, this.#cursorSecret));
      } catch {
        throw invalidArgument();
      }
      start = ordered.findIndex((entry) => compareByKeyDescIdAsc(entry, after) > 0);
      if (start === -1) start = ordered.length;
    }
    const slice = ordered.slice(start, start + bounded);
    const last = slice.at(-1);
    const hasMore = last ? start + slice.length < ordered.length : false;
    const nextCursor = hasMore
      ? encodeCursor({ after: { key: last.key, id: last.id }, operation, ownerScope, query }, this.#cursorSecret)
      : null;
    return { records: slice.map((entry) => entry.record), nextCursor };
  }

  async createProject({ ownerScope, input } = {}) {
    assertInput(input);
    const name = assertText(input.name, PROJECT_MEMORY_LIMITS.projectNameChars);
    const now = this.#now();
    const project = {
      id: this.#id('prj'),
      schema_version: PROJECT_MEMORY_SCHEMA_VERSION,
      name,
      normalized_name: normalize(name),
      description: input.description ?? null,
      category: input.category ?? null,
      status: 'active',
      aliases: Array.isArray(input.aliases) ? [...input.aliases] : [],
      created_at: now,
      updated_at: now,
      last_activity_at: now,
      latest_checkpoint_id: null,
    };
    try {
      return await this.#repository.createProject({ ownerScope, project });
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  async getProject({ ownerScope, input } = {}) {
    assertInput(input);
    return this.#getProjectOrThrow(ownerScope, assertId(input.project_id));
  }

  async listProjects({ ownerScope, input } = {}) {
    const request = input ?? {};
    const includeArchived = request.include_archived === true;
    let projects;
    try {
      projects = await this.#repository.listProjects({ ownerScope });
    } catch (error) {
      throw mapRepositoryError(error);
    }
    const visible = includeArchived ? projects : projects.filter(({ status }) => status !== 'archived');
    const { records, nextCursor } = this.#paginate({
      ownerScope,
      operation: 'list_projects',
      query: { include_archived: includeArchived },
      records: visible,
      cursor: request.cursor,
      limit: request.limit,
      sortKey: (project) => project.last_activity_at,
    });
    return { projects: records, next_cursor: nextCursor };
  }

  async findProjects({ ownerScope, input } = {}) {
    assertInput(input);
    const rawQuery = assertText(input.query, PROJECT_MEMORY_LIMITS.projectNameChars);
    const query = normalize(rawQuery);
    let projects;
    try {
      projects = await this.#repository.listProjects({ ownerScope });
    } catch (error) {
      throw mapRepositoryError(error);
    }
    const active = projects.filter(({ status }) => status !== 'archived');
    for (const matches of [
      active.filter(({ id }) => id === rawQuery),
      active.filter(({ normalized_name }) => normalized_name === query),
      active.filter(({ aliases }) => aliases.some((alias) => normalize(alias) === query)),
    ]) {
      if (matches.length === 1) return { result: 'resolved', project: matches[0] };
      if (matches.length > 1) return { result: 'ambiguous', candidates: this.#orderRefs(matches, input.limit) };
    }
    // Substring search is discovery-only: any hit is reported as ambiguous so
    // it never silently resolves to one project.
    const partial = active.filter(
      (project) => project.normalized_name.includes(query) || project.aliases.some((alias) => normalize(alias).includes(query)),
    );
    return partial.length ? { result: 'ambiguous', candidates: this.#orderRefs(partial, input.limit) } : { result: 'none', candidates: [] };
  }

  #orderRefs(projects, limit) {
    const bounded = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 20) : 20;
    return projects
      .map((project) => ({ record: project, key: project.last_activity_at, id: project.id }))
      .sort(compareByKeyDescIdAsc)
      .slice(0, bounded)
      .map((entry) => projectRef(entry.record));
  }

  async updateProject({ ownerScope, input } = {}) {
    assertInput(input);
    const projectId = assertId(input.project_id);
    const current = await this.#getProjectOrThrow(ownerScope, projectId);
    const next = { ...current, updated_at: this.#now() };
    if (input.name !== undefined) {
      next.name = assertText(input.name, PROJECT_MEMORY_LIMITS.projectNameChars);
      next.normalized_name = normalize(next.name);
    }
    if (input.description !== undefined) next.description = input.description;
    if (input.category !== undefined) next.category = input.category;
    if (input.aliases !== undefined) {
      if (!Array.isArray(input.aliases)) throw invalidArgument();
      next.aliases = [...input.aliases];
    }
    try {
      return await this.#repository.replaceProject({ ownerScope, projectId, project: next });
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  async archiveProject({ ownerScope, input } = {}) {
    assertInput(input);
    const projectId = assertId(input.project_id);
    const current = await this.#getProjectOrThrow(ownerScope, projectId);
    const next = { ...current, status: 'archived', updated_at: this.#now() };
    try {
      return await this.#repository.replaceProject({ ownerScope, projectId, project: next });
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  async deleteProject({ ownerScope, input } = {}) {
    assertInput(input);
    const projectId = assertId(input.project_id);
    // Missing or cross-owner records collapse to the same public not-found.
    await this.#getProjectOrThrow(ownerScope, projectId);
    try {
      await this.#repository.deleteProject({ ownerScope, projectId });
    } catch (error) {
      throw mapRepositoryError(error);
    }
    return { project_id: projectId };
  }

  async createSession({ ownerScope, input } = {}) {
    assertInput(input);
    const now = this.#now();
    const session = {
      id: this.#id('ses'),
      schema_version: PROJECT_MEMORY_SCHEMA_VERSION,
      project_id: assertId(input.project_id),
      source_client: assertText(input.source_client, PROJECT_MEMORY_LIMITS.sourceClientChars),
      source_model: input.source_model ?? null,
      status: 'active',
      source_conversation_reference: input.source_conversation_reference ?? null,
      metadata: input.metadata ?? { entries: [] },
      created_at: now,
      updated_at: now,
      latest_checkpoint_id: null,
    };
    try {
      return await this.#repository.createSession({ ownerScope, session });
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  async getSession({ ownerScope, input } = {}) {
    assertInput(input);
    const session = await this.#repository.getSession({
      ownerScope,
      projectId: assertId(input.project_id),
      sessionId: assertId(input.session_id),
    });
    if (!session) throw createMcpError(MCP_ERROR_CODES.NOT_FOUND);
    return session;
  }

  async listProjectSessions({ ownerScope, input } = {}) {
    assertInput(input);
    const projectId = assertId(input.project_id);
    await this.#getProjectOrThrow(ownerScope, projectId);
    const sessions = await this.#repository.listSessions({ ownerScope, projectId });
    const { records, nextCursor } = this.#paginate({
      ownerScope,
      operation: 'list_project_sessions',
      query: { project_id: projectId },
      records: sessions,
      cursor: input.cursor,
      limit: input.limit,
      sortKey: (session) => session.updated_at,
    });
    return { sessions: records, next_cursor: nextCursor };
  }

  async transitionSession({ ownerScope, input } = {}) {
    assertInput(input);
    const projectId = assertId(input.project_id);
    const sessionId = assertId(input.session_id);
    const status = input.status;
    const current = await this.#repository.getSession({ ownerScope, projectId, sessionId });
    if (!current) throw createMcpError(MCP_ERROR_CODES.NOT_FOUND);
    // Same-state requests are idempotent no-ops: no timestamp change, no write.
    if (current.status === status) return current;
    const allowed = TRANSITIONS[current.status];
    if (!allowed || !allowed.has(status)) throw createMcpError(MCP_ERROR_CODES.CONFLICT);
    const next = { ...current, status, updated_at: this.#now() };
    try {
      return await this.#repository.replaceSession({ ownerScope, projectId, sessionId, session: next });
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  async saveCheckpoint({ ownerScope, input } = {}) {
    assertInput(input);
    let request;
    try {
      request = validateSaveCheckpointInput(input);
    } catch {
      throw invalidArgument();
    }
    const checkpoint = request.checkpoint;
    const project = await this.#getProjectOrThrow(ownerScope, request.project_id);
    const now = this.#now();
    const nextProject = { ...project, updated_at: now, last_activity_at: now, latest_checkpoint_id: checkpoint.id };
    let nextSession;
    if (checkpoint.session_id !== null) {
      const session = await this.#repository.getSession({ ownerScope, projectId: request.project_id, sessionId: checkpoint.session_id });
      if (!session) throw createMcpError(MCP_ERROR_CODES.NOT_FOUND);
      nextSession = { ...session, updated_at: now, latest_checkpoint_id: checkpoint.id };
    }
    const idempotency = { key: request.idempotency_key, requestHash: requestHash(request) };
    try {
      return await this.#repository.saveCheckpoint({ ownerScope, checkpoint, project: nextProject, session: nextSession, idempotency });
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  async getLatestCheckpoint({ ownerScope, input } = {}) {
    assertInput(input);
    const project = await this.#getProjectOrThrow(ownerScope, assertId(input.project_id));
    const checkpoint = project.latest_checkpoint_id
      ? await this.#repository.getCheckpoint({ ownerScope, projectId: project.id, checkpointId: project.latest_checkpoint_id })
      : null;
    return { checkpoint: checkpoint ?? null, content_trust: CONTENT_TRUST };
  }

  async getCheckpoint({ ownerScope, input } = {}) {
    assertInput(input);
    const checkpoint = await this.#repository.getCheckpoint({
      ownerScope,
      projectId: assertId(input.project_id),
      checkpointId: assertId(input.checkpoint_id),
    });
    if (!checkpoint) throw createMcpError(MCP_ERROR_CODES.NOT_FOUND);
    return { checkpoint, content_trust: CONTENT_TRUST };
  }

  async listCheckpoints({ ownerScope, input } = {}) {
    assertInput(input);
    const projectId = assertId(input.project_id);
    await this.#getProjectOrThrow(ownerScope, projectId);
    const checkpoints = await this.#repository.listCheckpoints({ ownerScope, projectId });
    const { records, nextCursor } = this.#paginate({
      ownerScope,
      operation: 'list_checkpoints',
      query: { project_id: projectId },
      records: checkpoints,
      cursor: input.cursor,
      limit: input.limit,
      sortKey: (checkpoint) => String(checkpoint.revision).padStart(12, '0'),
    });
    return { checkpoints: records, next_cursor: nextCursor, content_trust: CONTENT_TRUST };
  }

  async resumeProject({ ownerScope, input } = {}) {
    assertInput(input);
    const projectId = assertId(input.project_id);
    let state;
    try {
      state = await this.#repository.inspectProjectState({ ownerScope, projectId });
    } catch (error) {
      throw mapRepositoryError(error);
    }
    const { project, sessions, checkpoints } = state;
    const byId = new Map(checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]));
    const inconsistent = () => ({
      project,
      latest_checkpoint: null,
      freshness: 'incomplete',
      warnings: [{ ...INCONSISTENT_WARNING }],
      content_trust: CONTENT_TRUST,
    });

    const head = project.latest_checkpoint_id;
    const maxRevision = checkpoints.reduce((max, checkpoint) => Math.max(max, checkpoint.revision), 0);
    const headCheckpoint = head === null ? null : byId.get(head);
    if (head === null ? checkpoints.length > 0 : !headCheckpoint || headCheckpoint.revision !== maxRevision) {
      return inconsistent();
    }
    for (const session of sessions) {
      if (session.latest_checkpoint_id !== null && !byId.has(session.latest_checkpoint_id)) return inconsistent();
    }
    const linkedSession = headCheckpoint && headCheckpoint.session_id !== null
      ? sessions.find((session) => session.id === headCheckpoint.session_id)
      : null;
    if (headCheckpoint && headCheckpoint.session_id !== null && (!linkedSession || linkedSession.latest_checkpoint_id !== head)) {
      return inconsistent();
    }

    const latestSessionActivityAt = sessions.reduce((max, session) => (session.updated_at > max ? session.updated_at : max), '');
    const { freshness, warnings } = assessResumeFreshness({
      latestCheckpointAt: headCheckpoint ? headCheckpoint.created_at : null,
      latestSessionActivityAt: latestSessionActivityAt || null,
      sessionStatus: linkedSession ? linkedSession.status : null,
    });
    return { project, latest_checkpoint: headCheckpoint ?? null, freshness, warnings, content_trust: CONTENT_TRUST };
  }

  async getProjectSummary({ ownerScope, input } = {}) {
    assertInput(input);
    const projectId = assertId(input.project_id);
    let state;
    try {
      state = await this.#repository.inspectProjectState({ ownerScope, projectId });
    } catch (error) {
      throw mapRepositoryError(error);
    }
    const { project, sessions, checkpoints } = state;
    const headCheckpoint = project.latest_checkpoint_id ? checkpoints.find(({ id }) => id === project.latest_checkpoint_id) : null;
    return {
      project,
      summary: {
        schema_version: PROJECT_MEMORY_SCHEMA_VERSION,
        current_status: headCheckpoint ? headCheckpoint.current_status : null,
        checkpoint_count: checkpoints.length,
        session_count: sessions.length,
        latest_checkpoint_id: project.latest_checkpoint_id,
      },
      content_trust: CONTENT_TRUST,
    };
  }
}

// Approved single-lifecycle transition table. Same-state requests are handled
// as no-ops before this table is consulted.
const TRANSITIONS = Object.freeze({
  active: new Set(['paused', 'interrupted', 'completed', 'archived']),
  paused: new Set(['active', 'interrupted', 'completed', 'archived']),
  interrupted: new Set(['active', 'completed', 'archived']),
  completed: new Set(['archived']),
  archived: new Set(),
});
