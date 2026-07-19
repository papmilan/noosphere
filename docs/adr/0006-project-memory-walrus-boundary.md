# ADR 0006: Keep Walrus Outside Project Memory v1 Structured State

- **Status:** Accepted
- **Date:** 2026-07-19
- **Decision owners:** Noosphere maintainers

## Context

Walrus-backed memory is an existing Noosphere capability, but Project Memory
requires low-latency owner-scoped queries, mutations, revisions, retention,
and deletion. Public or managed blob storage is not an appropriate primary
control plane for sensitive conversation continuity.

## Decision

Project Memory v1 stores structured checkpoints only in the PostgreSQL control
plane. It stores no transcripts, checkpoint payloads, or project state in
Walrus and implements no artifact upload/retrieval in PR 1.

A future optional artifact provider may use application-layer envelope
encryption, separate per-owner keys, opaque provider references in PostgreSQL,
and explicit availability degradation. It must not change existing
Walrus-relayer behavior.

## Consequences

- The v1 privacy boundary is smaller and testable.
- There is no claim of zero-knowledge storage or guaranteed Walrus
  availability.
- Full transcripts, attachments, URL fetching, and artifacts remain out of
  scope.
