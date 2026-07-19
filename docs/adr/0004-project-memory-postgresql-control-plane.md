# ADR 0004: Use PostgreSQL for the Project Memory Control Plane

- **Status:** Accepted
- **Date:** 2026-07-19
- **Decision owners:** Noosphere maintainers

## Context

Project Memory needs owner-scoped queries, exact revision history, aliases,
bounded search, idempotency, archive/deletion lifecycle, quotas, and cursor
pagination. The existing relayer JSON durable store is intentionally
single-instance state and cannot provide those multi-tenant guarantees.

## Decision

Use PostgreSQL as the production control plane. The storage port will model
projects, sessions, checkpoints, aliases, idempotency records, retention
markers, and opaque artifact references. Every storage operation receives an
authenticated owner scope and applies it to reads and writes.

PR 1 includes a pure port and an in-memory test implementation only. PR 3 will
add migrations and a PostgreSQL adapter. Development guidance will use a local
Docker Compose PostgreSQL instance; production reference deployment targets an
EU region but makes no legal-compliance claim.

## Consequences

- Names, ownership, lifecycle, and structured checkpoint state are queryable
  and deletable without object-store scans.
- Horizontal operation requires a shared database and later distributed
  rate-limiting; neither is implied by PR 1.
- Existing JSON stores remain supported only for their current relayer role.

