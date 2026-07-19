import { PROJECT_MEMORY_SCHEMA_VERSION } from './constants.js';

const text = (maxLength) => ({ type: 'string', minLength: 1, maxLength });
const timestamp = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' };
const id = { type: 'string', pattern: '^[a-z][a-z0-9_]{2,127}$' };
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const closed = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, required, properties });

const metadataScalar = {
  oneOf: [
    closed({ kind: { const: 'string' }, value: text(4_000) }),
    closed({ kind: { const: 'number' }, value: { type: 'number' } }),
    closed({ kind: { const: 'boolean' }, value: { type: 'boolean' } }),
    closed({ kind: { const: 'null' }, value: { type: 'null' } }),
  ],
};
const metadataKey = {
  allOf: [
    { type: 'string', minLength: 1, maxLength: 80, pattern: '^[a-z][a-z0-9_]{0,79}$' },
    { not: { enum: ['owner', 'tenant', 'user', 'user_id', 'subject', 'token', 'authorization', 'api_key', 'access_token', 'refresh_token', 'password', 'chain_of_thought', 'hidden_chain_of_thought', 'reasoning', 'internal_reasoning', 'model_private_context', 'transcript', 'attachments', 'url', 'urls'] } },
  ],
};
const metadataEntry = (value) => closed({ key: metadataKey, value });
const metadataValue = (depth) => (depth === 0 ? metadataScalar : {
  oneOf: [
    metadataScalar,
    closed({ kind: { const: 'list' }, items: { type: 'array', maxItems: 20, items: metadataValue(depth - 1) } }),
    closed({ kind: { const: 'record' }, entries: { type: 'array', maxItems: 20, items: metadataEntry(metadataValue(depth - 1)) } }),
  ],
});

// Entry arrays deliberately replace open-ended JSON maps. This makes every
// object closed while retaining bounded nested metadata and auditable keys.
export const METADATA_SCHEMA = Object.freeze(closed({
  entries: { type: 'array', maxItems: 20, items: metadataEntry(metadataValue(3)) },
}));

export const PROJECT_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://noosphere.dev/schemas/project-memory/project-1.0.0.json',
  ...closed({
    id,
    schema_version: { const: PROJECT_MEMORY_SCHEMA_VERSION },
    name: text(160),
    normalized_name: text(160),
    description: nullable(text(2_000)),
    category: nullable(text(80)),
    status: { enum: ['active', 'paused', 'completed', 'archived'] },
    aliases: { type: 'array', maxItems: 32, items: text(160) },
    created_at: timestamp,
    updated_at: timestamp,
    last_activity_at: timestamp,
    latest_checkpoint_id: nullable(id),
  }, ['id', 'schema_version', 'name', 'normalized_name', 'status', 'aliases', 'created_at', 'updated_at', 'last_activity_at', 'latest_checkpoint_id']),
});

export const PROJECT_RECORD_SCHEMA = Object.freeze({
  ...PROJECT_SCHEMA,
  $id: 'https://noosphere.dev/schemas/project-memory/project-record-1.0.0.json',
  required: [...PROJECT_SCHEMA.required, 'owner_scope'],
  properties: { ...PROJECT_SCHEMA.properties, owner_scope: text(512) },
});

export const SESSION_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://noosphere.dev/schemas/project-memory/session-1.0.0.json',
  ...closed({
    id, schema_version: { const: PROJECT_MEMORY_SCHEMA_VERSION }, project_id: id,
    source_client: text(80), source_model: nullable(text(160)),
    status: { enum: ['active', 'paused', 'interrupted', 'completed', 'archived'] },
    source_conversation_reference: nullable(text(160)), metadata: METADATA_SCHEMA,
    created_at: timestamp, updated_at: timestamp, latest_checkpoint_id: nullable(id),
  }),
});

const checkpointTextSections = ['established_facts', 'decisions', 'rejected_options', 'assumptions', 'constraints', 'completed_work', 'unresolved_questions', 'blockers', 'next_actions', 'verification_or_evidence'];

export const CHECKPOINT_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://noosphere.dev/schemas/project-memory/checkpoint-1.0.0.json',
  ...closed({
    id, schema_version: { const: PROJECT_MEMORY_SCHEMA_VERSION }, project_id: id, session_id: nullable(id),
    revision: { type: 'integer', minimum: 1 }, previous_checkpoint_id: nullable(id), goal: text(4_000), current_status: text(4_000),
    ...Object.fromEntries(checkpointTextSections.map((key) => [key, { type: 'array', maxItems: 100, items: text(4_000) }])),
    source_summary: text(4_000), source: closed({ client: text(80), model: nullable(text(160)) }), created_at: timestamp,
  }),
});

export const CHECKPOINT_SAVE_INPUT_SCHEMA = Object.freeze(closed({
  project_id: id,
  session_id: nullable(id),
  checkpoint: CHECKPOINT_SCHEMA,
  idempotency_key: text(128),
}, ['project_id', 'checkpoint', 'idempotency_key']));

export const PROJECT_MEMORY_SCHEMAS = Object.freeze({ project: PROJECT_SCHEMA, project_record: PROJECT_RECORD_SCHEMA, session: SESSION_SCHEMA, checkpoint: CHECKPOINT_SCHEMA, metadata: METADATA_SCHEMA, checkpoint_save_input: CHECKPOINT_SAVE_INPUT_SCHEMA });
