import { PROJECT_MEMORY_SCHEMA_VERSION } from './constants.js';

const text = (maxLength) => ({ type: 'string', minLength: 1, maxLength });
const timestamp = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' };
const id = { type: 'string', pattern: '^[a-z][a-z0-9_]{2,127}$' };
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });

export const PROJECT_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://noosphere.dev/schemas/project-memory/project-1.0.0.json',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'schema_version', 'name', 'normalized_name', 'status', 'aliases', 'archived', 'created_at', 'updated_at', 'last_activity_at', 'latest_checkpoint_id'],
  properties: {
    id,
    schema_version: { const: PROJECT_MEMORY_SCHEMA_VERSION },
    name: text(160),
    normalized_name: text(160),
    description: nullable(text(2_000)),
    category: nullable(text(80)),
    status: { enum: ['active', 'paused', 'completed', 'archived'] },
    aliases: { type: 'array', maxItems: 32, items: text(160) },
    archived: { type: 'boolean' },
    created_at: timestamp,
    updated_at: timestamp,
    last_activity_at: timestamp,
    latest_checkpoint_id: nullable(id),
  },
});

// This schema is storage-only. MCP tools expose PROJECT_SCHEMA and obtain this
// owner binding solely from the authenticated server context.
export const PROJECT_RECORD_SCHEMA = Object.freeze({
  ...PROJECT_SCHEMA,
  $id: 'https://noosphere.dev/schemas/project-memory/project-record-1.0.0.json',
  required: [...PROJECT_SCHEMA.required, 'owner_scope'],
  properties: { ...PROJECT_SCHEMA.properties, owner_scope: text(512) },
});

export const SESSION_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://noosphere.dev/schemas/project-memory/session-1.0.0.json',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'schema_version', 'project_id', 'source_client', 'source_model', 'status', 'source_conversation_reference', 'metadata', 'created_at', 'updated_at', 'latest_checkpoint_id'],
  properties: {
    id,
    schema_version: { const: PROJECT_MEMORY_SCHEMA_VERSION },
    project_id: id,
    source_client: text(80),
    source_model: nullable(text(160)),
    status: { enum: ['active', 'paused', 'interrupted', 'completed', 'archived'] },
    source_conversation_reference: nullable(text(160)),
    metadata: { type: 'object', maxProperties: 20, additionalProperties: { type: ['string', 'number', 'boolean', 'null'] } },
    created_at: timestamp,
    updated_at: timestamp,
    latest_checkpoint_id: nullable(id),
  },
});

const checkpointTextSections = [
  'established_facts', 'decisions', 'rejected_options', 'assumptions',
  'constraints', 'completed_work', 'unresolved_questions', 'blockers',
  'next_actions', 'verification_or_evidence',
];

export const CHECKPOINT_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://noosphere.dev/schemas/project-memory/checkpoint-1.0.0.json',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'schema_version', 'project_id', 'session_id', 'revision', 'previous_checkpoint_id', 'goal', 'current_status', ...checkpointTextSections, 'source_summary', 'source', 'created_at'],
  properties: {
    id,
    schema_version: { const: PROJECT_MEMORY_SCHEMA_VERSION },
    project_id: id,
    session_id: nullable(id),
    revision: { type: 'integer', minimum: 1 },
    previous_checkpoint_id: nullable(id),
    goal: text(4_000),
    current_status: text(4_000),
    ...Object.fromEntries(checkpointTextSections.map((key) => [key, { type: 'array', maxItems: 100, items: text(4_000) }])),
    source_summary: text(4_000),
    source: { type: 'object', additionalProperties: false, required: ['client', 'model'], properties: { client: text(80), model: nullable(text(160)) } },
    created_at: timestamp,
  },
});

export const PROJECT_MEMORY_SCHEMAS = Object.freeze({
  project: PROJECT_SCHEMA,
  project_record: PROJECT_RECORD_SCHEMA,
  session: SESSION_SCHEMA,
  checkpoint: CHECKPOINT_SCHEMA,
});
