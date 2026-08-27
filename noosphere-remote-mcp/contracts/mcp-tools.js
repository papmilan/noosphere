import { CHECKPOINT_SAVE_INPUT_SCHEMA, CHECKPOINT_SCHEMA, METADATA_SCHEMA, PROJECT_SCHEMA, SESSION_SCHEMA } from './schemas.js';

const id = { type: 'string', pattern: '^[a-z][a-z0-9_]{2,127}$' };
const text = (maxLength = 4_000) => ({ type: 'string', minLength: 1, maxLength });
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const closed = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, required, properties });
const page = closed({ cursor: nullable(text(512)), limit: { type: 'integer', minimum: 1, maximum: 100 } }, []);
const projectRef = closed({ schema_version: { const: 'noosphere.project-memory/1.0.0' }, id, name: text(160), status: { enum: ['active', 'paused', 'completed', 'archived'] }, last_activity_at: text(32) });
const warning = closed({ schema_version: { const: 'noosphere.project-memory/1.0.0' }, code: { enum: ['interrupted-session', 'checkpoint-predates-session', 'no-durable-checkpoint', 'repository-state-inconsistent'] }, message: text(320) });
const summary = closed({ schema_version: { const: 'noosphere.project-memory/1.0.0' }, current_status: nullable(text()), checkpoint_count: { type: 'integer', minimum: 0 }, session_count: { type: 'integer', minimum: 0 }, latest_checkpoint_id: nullable(id) });
const untrusted = { const: 'untrusted-persisted-data' };
const input = closed;
const output = closed;

export const MCP_TOOLS = Object.freeze({
  create_project: { input: input({ name: text(160), description: nullable(text(2_000)), category: nullable(text(80)), aliases: { type: 'array', maxItems: 32, items: text(160) } }, ['name']), output: output({ project: PROJECT_SCHEMA }) },
  list_projects: { input: input({ ...page.properties, include_archived: { type: 'boolean' } }, []), output: output({ projects: { type: 'array', maxItems: 100, items: PROJECT_SCHEMA }, next_cursor: nullable(text(512)) }) },
  get_project: { input: input({ project_id: id }), output: output({ project: PROJECT_SCHEMA }) },
  find_projects: { input: input({ query: text(160), limit: { type: 'integer', minimum: 1, maximum: 20 } }, ['query']), output: { oneOf: [output({ result: { const: 'resolved' }, project: PROJECT_SCHEMA }), output({ result: { const: 'ambiguous' }, candidates: { type: 'array', minItems: 2, maxItems: 20, items: projectRef } }), output({ result: { const: 'none' }, candidates: { type: 'array', maxItems: 0, items: projectRef } })] } },
  update_project: { input: input({ project_id: id, name: text(160), description: nullable(text(2_000)), category: nullable(text(80)), aliases: { type: 'array', maxItems: 32, items: text(160) } }, ['project_id']), output: output({ project: PROJECT_SCHEMA }) },
  archive_project: { input: input({ project_id: id }), output: output({ project: PROJECT_SCHEMA }) },
  create_session: { input: input({ project_id: id, source_client: text(80), source_model: nullable(text(160)), source_conversation_reference: nullable(text(160)), metadata: METADATA_SCHEMA }, ['project_id', 'source_client']), output: output({ session: SESSION_SCHEMA }) },
  get_session: { input: input({ project_id: id, session_id: id }), output: output({ session: SESSION_SCHEMA }) },
  list_project_sessions: { input: input({ project_id: id, ...page.properties }), output: output({ sessions: { type: 'array', maxItems: 100, items: SESSION_SCHEMA }, next_cursor: nullable(text(512)) }) },
  transition_session: { input: input({ project_id: id, session_id: id, status: { enum: ['active', 'paused', 'interrupted', 'completed', 'archived'] } }), output: output({ session: SESSION_SCHEMA }) },
  save_checkpoint: { input: CHECKPOINT_SAVE_INPUT_SCHEMA, output: output({ checkpoint: CHECKPOINT_SCHEMA, deduplicated: { type: 'boolean' } }) },
  get_latest_checkpoint: { input: input({ project_id: id }), output: output({ checkpoint: nullable(CHECKPOINT_SCHEMA), content_trust: untrusted }) },
  get_checkpoint: { input: input({ project_id: id, checkpoint_id: id }), output: output({ checkpoint: CHECKPOINT_SCHEMA, content_trust: untrusted }) },
  list_checkpoints: { input: input({ project_id: id, ...page.properties }), output: output({ checkpoints: { type: 'array', maxItems: 100, items: CHECKPOINT_SCHEMA }, next_cursor: nullable(text(512)), content_trust: untrusted }) },
  resume_project: { input: input({ project_id: id }), output: output({ project: PROJECT_SCHEMA, latest_checkpoint: nullable(CHECKPOINT_SCHEMA), freshness: { enum: ['fresh', 'stale', 'incomplete'] }, warnings: { type: 'array', maxItems: 10, items: warning }, content_trust: untrusted }) },
  get_project_summary: { input: input({ project_id: id }), output: output({ project: PROJECT_SCHEMA, summary, content_trust: untrusted }) },
});
