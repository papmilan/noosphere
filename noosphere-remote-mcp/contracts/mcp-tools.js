const id = { type: 'string', pattern: '^[a-z][a-z0-9_]{2,127}$' };
const text = (maxLength = 4_000) => ({ type: 'string', minLength: 1, maxLength });
const page = {
  type: 'object',
  additionalProperties: false,
  properties: {
    cursor: { anyOf: [text(512), { type: 'null' }] },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  },
};
const input = (properties, required = Object.keys(properties)) => ({
  type: 'object',
  additionalProperties: false,
  required,
  properties,
});
const output = (properties, required = Object.keys(properties)) => ({
  type: 'object',
  additionalProperties: false,
  required,
  properties,
});
const projectRef = { type: 'object', additionalProperties: false, required: ['id', 'name', 'status', 'last_activity_at'], properties: { id, name: text(160), status: text(32), last_activity_at: text(32) } };
const untrusted = { const: 'untrusted-persisted-data' };

export const MCP_TOOLS = Object.freeze({
  create_project: { input: input({ name: text(160), description: { anyOf: [text(2_000), { type: 'null' }] }, category: { anyOf: [text(80), { type: 'null' }] }, aliases: { type: 'array', maxItems: 32, items: text(160) } }, ['name']), output: output({ project: projectRef }) },
  list_projects: { input: input({ ...page.properties, include_archived: { type: 'boolean' } }, []), output: output({ projects: { type: 'array', items: projectRef }, next_cursor: { anyOf: [text(512), { type: 'null' }] } }) },
  get_project: { input: input({ project_id: id }), output: output({ project: projectRef }) },
  find_projects: { input: input({ query: text(160), limit: { type: 'integer', minimum: 1, maximum: 20 } }, ['query']), output: { oneOf: [
    output({ result: { const: 'resolved' }, project: projectRef }),
    output({ result: { const: 'ambiguous' }, candidates: { type: 'array', minItems: 2, maxItems: 20, items: projectRef } }),
    output({ result: { const: 'none' }, candidates: { type: 'array', maxItems: 0 } }),
  ] } },
  update_project: { input: input({ project_id: id, name: text(160), description: { anyOf: [text(2_000), { type: 'null' }] }, category: { anyOf: [text(80), { type: 'null' }] }, aliases: { type: 'array', maxItems: 32, items: text(160) } }, ['project_id']), output: output({ project: projectRef }) },
  archive_project: { input: input({ project_id: id }), output: output({ project: projectRef }) },
  create_session: { input: input({ project_id: id, source_client: text(80), source_model: { anyOf: [text(160), { type: 'null' }] }, source_conversation_reference: { anyOf: [text(160), { type: 'null' }] }, metadata: { type: 'object', maxProperties: 20 } }, ['project_id', 'source_client']), output: output({ session_id: id }) },
  get_session: { input: input({ project_id: id, session_id: id }), output: output({ session: { type: 'object' } }) },
  list_project_sessions: { input: input({ project_id: id, ...page.properties }), output: output({ sessions: { type: 'array', items: { type: 'object' } }, next_cursor: { anyOf: [text(512), { type: 'null' }] } }) },
  save_checkpoint: { input: input({ project_id: id, session_id: { anyOf: [id, { type: 'null' }] }, checkpoint: { type: 'object' }, idempotency_key: text(128) }, ['project_id', 'checkpoint', 'idempotency_key']), output: output({ checkpoint_id: id, revision: { type: 'integer', minimum: 1 }, deduplicated: { type: 'boolean' } }) },
  get_latest_checkpoint: { input: input({ project_id: id }), output: output({ checkpoint: { anyOf: [{ type: 'object' }, { type: 'null' }] }, content_trust: untrusted }) },
  get_checkpoint: { input: input({ project_id: id, checkpoint_id: id }), output: output({ checkpoint: { type: 'object' }, content_trust: untrusted }) },
  list_checkpoints: { input: input({ project_id: id, ...page.properties }), output: output({ checkpoints: { type: 'array', items: { type: 'object' } }, next_cursor: { anyOf: [text(512), { type: 'null' }] }, content_trust: untrusted }) },
  resume_project: { input: input({ project_id: id }), output: output({ project: projectRef, latest_checkpoint: { anyOf: [{ type: 'object' }, { type: 'null' }] }, freshness: text(32), warnings: { type: 'array', maxItems: 10, items: { type: 'object' } }, content_trust: untrusted }) },
  get_project_summary: { input: input({ project_id: id }), output: output({ project: projectRef, summary: { type: 'object' }, content_trust: untrusted }) },
});
