export const PROJECT_MEMORY_SCHEMA_VERSION = 'noosphere.project-memory/1.0.0';

export const PROJECT_MEMORY_LIMITS = Object.freeze({
  projectNameChars: 160,
  descriptionChars: 2_000,
  categoryChars: 80,
  aliasChars: 160,
  aliasesPerProject: 32,
  sourceClientChars: 80,
  sourceModelChars: 160,
  metadataBytes: 4_096,
  itemChars: 4_000,
  itemsPerSection: 100,
  checkpointBytes: 131_072,
  pageSizeDefault: 20,
  pageSizeMaximum: 100,
});
