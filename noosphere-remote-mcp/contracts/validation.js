import { PROJECT_MEMORY_LIMITS, PROJECT_MEMORY_SCHEMA_VERSION } from './constants.js';

const ID = /^[a-z][a-z0-9_]{2,127}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
const PRIVATE_KEYS = new Set([
  'chain_of_thought', 'hidden_chain_of_thought', 'reasoning', 'internal_reasoning',
  'model_private_context', 'transcript', 'attachments', 'url', 'urls',
]);
const FORBIDDEN_METADATA_KEYS = new Set([
  'owner', 'tenant', 'user', 'user_id', 'subject', 'token', 'authorization',
  'api_key', 'access_token', 'refresh_token', 'password', ...PRIVATE_KEYS,
]);
const METADATA_KEY = /^[a-z][a-z0-9_]{0,79}$/;

function fail(code) {
  throw new Error(code);
}

function assertObject(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`invalid-object:${path}`);
}

function assertExactKeys(value, allowed, required, path) {
  assertObject(value, path);
  for (const key of Object.keys(value)) {
    if (PRIVATE_KEYS.has(key) || !allowed.has(key)) fail(`unknown-field:${path === 'root' ? key : `${path}.${key}`}`);
  }
  for (const key of required) {
    if (!(key in value)) fail(`missing-field:${path === 'root' ? key : `${path}.${key}`}`);
  }
}

function assertText(value, path, maximum, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || value.length === 0) fail(`invalid-string:${path}`);
  if (value.length > maximum) fail(`string-limit:${path}`);
  if (CONTROL.test(value)) fail(`control-character:${path}`);
}

function assertId(value, path, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !ID.test(value)) fail(`invalid-id:${path}`);
}

function assertTimestamp(value, path) {
  if (typeof value !== 'string' || !TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) fail(`invalid-timestamp:${path}`);
}

function assertEnum(value, path, values) {
  if (!values.includes(value)) fail(`invalid-enum:${path}`);
}

function assertArray(value, path, maximum = PROJECT_MEMORY_LIMITS.itemsPerSection) {
  if (!Array.isArray(value)) fail(`invalid-array:${path}`);
  if (value.length > maximum) fail(`array-limit:${path}`);
  for (const [index, item] of value.entries()) assertText(item, `${path}[${index}]`, PROJECT_MEMORY_LIMITS.itemChars);
}

function assertSchemaVersion(value) {
  if (value !== PROJECT_MEMORY_SCHEMA_VERSION) fail('unsupported-schema-version');
}

function assertPayloadBound(value) {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > PROJECT_MEMORY_LIMITS.checkpointBytes) fail('payload-limit');
}

export function validateProject(value) {
  const allowed = new Set(['id', 'schema_version', 'name', 'normalized_name', 'description', 'category', 'status', 'aliases', 'created_at', 'updated_at', 'last_activity_at', 'latest_checkpoint_id']);
  const required = new Set(['id', 'schema_version', 'name', 'normalized_name', 'status', 'aliases', 'created_at', 'updated_at', 'last_activity_at', 'latest_checkpoint_id']);
  assertExactKeys(value, allowed, required, 'root');
  assertId(value.id, 'id');
  assertSchemaVersion(value.schema_version);
  assertText(value.name, 'name', PROJECT_MEMORY_LIMITS.projectNameChars);
  assertText(value.normalized_name, 'normalized_name', PROJECT_MEMORY_LIMITS.projectNameChars);
  assertText(value.description, 'description', PROJECT_MEMORY_LIMITS.descriptionChars, { nullable: true });
  assertText(value.category, 'category', PROJECT_MEMORY_LIMITS.categoryChars, { nullable: true });
  assertEnum(value.status, 'status', ['active', 'paused', 'completed', 'archived']);
  assertArray(value.aliases, 'aliases', PROJECT_MEMORY_LIMITS.aliasesPerProject);
  for (const [index, alias] of value.aliases.entries()) assertText(alias, `aliases[${index}]`, PROJECT_MEMORY_LIMITS.aliasChars);
  assertTimestamp(value.created_at, 'created_at');
  assertTimestamp(value.updated_at, 'updated_at');
  assertTimestamp(value.last_activity_at, 'last_activity_at');
  assertId(value.latest_checkpoint_id, 'latest_checkpoint_id', { nullable: true });
  return structuredClone(value);
}

export function validateSession(value) {
  const allowed = new Set(['id', 'schema_version', 'project_id', 'source_client', 'source_model', 'status', 'source_conversation_reference', 'metadata', 'created_at', 'updated_at', 'latest_checkpoint_id']);
  const required = new Set(allowed);
  assertExactKeys(value, allowed, required, 'root');
  assertId(value.id, 'id');
  assertSchemaVersion(value.schema_version);
  assertId(value.project_id, 'project_id');
  assertText(value.source_client, 'source_client', PROJECT_MEMORY_LIMITS.sourceClientChars);
  assertText(value.source_model, 'source_model', PROJECT_MEMORY_LIMITS.sourceModelChars, { nullable: true });
  assertEnum(value.status, 'status', ['active', 'paused', 'interrupted', 'completed', 'archived']);
  assertText(value.source_conversation_reference, 'source_conversation_reference', PROJECT_MEMORY_LIMITS.sourceModelChars, { nullable: true });
  assertExactMetadata(value.metadata);
  assertTimestamp(value.created_at, 'created_at');
  assertTimestamp(value.updated_at, 'updated_at');
  assertId(value.latest_checkpoint_id, 'latest_checkpoint_id', { nullable: true });
  return structuredClone(value);
}

function assertExactMetadata(value) {
  assertObject(value, 'metadata');
  assertExactKeys(value, new Set(['entries']), new Set(['entries']), 'metadata');
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > PROJECT_MEMORY_LIMITS.metadataBytes) fail('metadata-limit');
  assertMetadataEntries(value.entries, 'metadata.entries', 3);
}

function assertMetadataEntries(value, path, depth) {
  if (!Array.isArray(value)) fail(`invalid-array:${path}`);
  if (value.length > 20) fail(`metadata-limit:${path}`);
  for (const [index, entry] of value.entries()) {
    const entryPath = `${path}[${index}]`;
    assertExactKeys(entry, new Set(['key', 'value']), new Set(['key', 'value']), entryPath);
    assertText(entry.key, `${entryPath}.key`, 80);
    if (!METADATA_KEY.test(entry.key)) fail(`invalid-metadata-key:${entryPath}.key`);
    if (FORBIDDEN_METADATA_KEYS.has(entry.key)) fail(`forbidden-metadata-key:${entryPath}.key`);
    assertMetadataValue(entry.value, `${entryPath}.value`, depth);
  }
}

function assertMetadataValue(value, path, depth) {
  assertObject(value, 'metadata-value');
  if (typeof value.kind !== 'string') fail(`invalid-metadata:${path}`);
  if (['string', 'number', 'boolean', 'null'].includes(value.kind)) {
    assertExactKeys(value, new Set(['kind', 'value']), new Set(['kind', 'value']), 'metadata-value');
    if (value.kind === 'string') assertText(value.value, `${path}.value`, PROJECT_MEMORY_LIMITS.itemChars);
    if (value.kind === 'number' && (typeof value.value !== 'number' || !Number.isFinite(value.value))) fail(`invalid-metadata:${path}`);
    if (value.kind === 'boolean' && typeof value.value !== 'boolean') fail(`invalid-metadata:${path}`);
    if (value.kind === 'null' && value.value !== null) fail(`invalid-metadata:${path}`);
    return;
  }
  if (depth <= 0) fail(`metadata-depth:${path}`);
  if (value.kind === 'list') {
    assertExactKeys(value, new Set(['kind', 'items']), new Set(['kind', 'items']), 'metadata-value');
    if (!Array.isArray(value.items) || value.items.length > 20) fail(`metadata-limit:${path}`);
    for (const [index, item] of value.items.entries()) assertMetadataValue(item, `${path}.items[${index}]`, depth - 1);
    return;
  }
  if (value.kind === 'record') {
    assertExactKeys(value, new Set(['kind', 'entries']), new Set(['kind', 'entries']), 'metadata-value');
    assertMetadataEntries(value.entries, `${path}.entries`, depth - 1);
    return;
  }
  fail(`invalid-metadata:${path}`);
}

export function validateCheckpoint(value) {
  const sections = ['established_facts', 'decisions', 'rejected_options', 'assumptions', 'constraints', 'completed_work', 'unresolved_questions', 'blockers', 'next_actions', 'verification_or_evidence'];
  const allowed = new Set(['id', 'schema_version', 'project_id', 'session_id', 'revision', 'previous_checkpoint_id', 'goal', 'current_status', ...sections, 'source_summary', 'source', 'created_at']);
  const required = new Set(allowed);
  assertExactKeys(value, allowed, required, 'root');
  assertPayloadBound(value);
  assertId(value.id, 'id');
  assertSchemaVersion(value.schema_version);
  assertId(value.project_id, 'project_id');
  assertId(value.session_id, 'session_id', { nullable: true });
  if (!Number.isInteger(value.revision) || value.revision < 1) fail('invalid-revision');
  assertId(value.previous_checkpoint_id, 'previous_checkpoint_id', { nullable: true });
  if ((value.revision === 1) !== (value.previous_checkpoint_id === null) || value.previous_checkpoint_id === value.id) fail('revision-predecessor');
  assertText(value.goal, 'goal', PROJECT_MEMORY_LIMITS.itemChars);
  assertText(value.current_status, 'current_status', PROJECT_MEMORY_LIMITS.itemChars);
  for (const section of sections) assertArray(value[section], section);
  assertText(value.source_summary, 'source_summary', PROJECT_MEMORY_LIMITS.itemChars);
  assertExactKeys(value.source, new Set(['client', 'model']), new Set(['client', 'model']), 'source');
  assertText(value.source.client, 'source.client', PROJECT_MEMORY_LIMITS.sourceClientChars);
  assertText(value.source.model, 'source.model', PROJECT_MEMORY_LIMITS.sourceModelChars, { nullable: true });
  assertTimestamp(value.created_at, 'created_at');
  return structuredClone(value);
}

export function validateSaveCheckpointInput(value) {
  const allowed = new Set(['project_id', 'session_id', 'checkpoint', 'idempotency_key']);
  const required = new Set(['project_id', 'checkpoint', 'idempotency_key']);
  assertExactKeys(value, allowed, required, 'root');
  assertId(value.project_id, 'project_id');
  if ('session_id' in value) assertId(value.session_id, 'session_id', { nullable: true });
  assertText(value.idempotency_key, 'idempotency_key', 128);
  const checkpoint = validateCheckpoint(value.checkpoint);
  if (checkpoint.project_id !== value.project_id) fail('checkpoint-project-mismatch');
  if (value.session_id !== undefined && checkpoint.session_id !== value.session_id) fail('checkpoint-session-mismatch');
  return structuredClone(value);
}
