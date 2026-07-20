-- Retention markers for the export/deletion lifecycle. Owner-scoped, one marker
-- per project; a project past its retain_until is eligible for a purge job.
create table retention_markers (
  owner_scope text not null,
  project_id text not null,
  retain_until timestamptz not null,
  reason text,
  created_at timestamptz not null default now(),
  primary key (owner_scope, project_id)
);
create index retention_due on retention_markers (owner_scope, retain_until);
