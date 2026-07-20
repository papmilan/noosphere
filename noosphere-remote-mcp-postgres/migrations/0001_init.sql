-- Remote Project Memory control-plane schema (ADR 0004).
--
-- Each domain record is stored verbatim as a jsonb `document` so the repository
-- round-trips exactly what the pure-core service produced (deepEqual parity with
-- the in-memory repository). Generated columns project the queryable fields for
-- owner-scoping, collision-safe keys, strict linear history, and pagination.
-- `owner_scope` is the tenancy key and is never part of a domain document.

create table projects (
  owner_scope text not null,
  seq bigint generated always as identity,
  document jsonb not null,
  id text generated always as (document ->> 'id') stored,
  normalized_name text generated always as (document ->> 'normalized_name') stored,
  status text generated always as (document ->> 'status') stored,
  last_activity_at text generated always as (document ->> 'last_activity_at') stored,
  latest_checkpoint_id text generated always as (document ->> 'latest_checkpoint_id') stored,
  primary key (owner_scope, id)
);
create index projects_owner_activity on projects (owner_scope, last_activity_at desc, id asc);

create table sessions (
  owner_scope text not null,
  seq bigint generated always as identity,
  document jsonb not null,
  project_id text generated always as (document ->> 'project_id') stored,
  id text generated always as (document ->> 'id') stored,
  updated_at text generated always as (document ->> 'updated_at') stored,
  latest_checkpoint_id text generated always as (document ->> 'latest_checkpoint_id') stored,
  primary key (owner_scope, project_id, id)
);
create index sessions_owner_project_updated on sessions (owner_scope, project_id, updated_at desc, id asc);

create table checkpoints (
  owner_scope text not null,
  seq bigint generated always as identity,
  document jsonb not null,
  project_id text generated always as (document ->> 'project_id') stored,
  id text generated always as (document ->> 'id') stored,
  revision integer generated always as ((document ->> 'revision')::integer) stored,
  previous_checkpoint_id text generated always as (document ->> 'previous_checkpoint_id') stored,
  session_id text generated always as (document ->> 'session_id') stored,
  primary key (owner_scope, project_id, id),
  -- Strictly linear checkpoint history v1: at most one checkpoint per revision.
  unique (owner_scope, project_id, revision)
);

create table idempotency_receipts (
  owner_scope text not null,
  operation text not null,
  idempotency_key text not null,
  request_hash text not null,
  result jsonb not null,
  -- Nullable project association so a project delete removes only its receipts.
  project_id text,
  created_at timestamptz not null default now(),
  primary key (owner_scope, operation, idempotency_key)
);
create index idempotency_owner_project on idempotency_receipts (owner_scope, project_id);
