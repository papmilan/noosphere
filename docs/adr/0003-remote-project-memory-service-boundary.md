# ADR 0003: Isolate Remote Project Memory as Its Own Service

- **Status:** Accepted
- **Date:** 2026-07-19
- **Decision owners:** Noosphere maintainers
- **Related specification:** `docs/design/specs/2026-07-19-remote-project-memory-contracts-design.md`

## Context

The existing `noosphere-mcp` package is a local, repository-oriented CLI and
the existing relayer is a single-deployment HTTP service. Neither supplies
authenticated multi-tenant MCP semantics. Retrofitting them would couple a new
public boundary to CSP, ACP, local filesystem access, and legacy bearer-token
configuration.

## Decision

Create a separately deployable `noosphere-remote-mcp` service. It owns remote
MCP transport, authenticated request context, Project Memory tool handling, and
its own storage port. Its process layer is stateless except for request-local
MCP session handling and retry-safe idempotency state held by storage.

The service consumes a Project Memory contract package but does not import the
local CLI, filesystem project state, or existing relayer runtime.

## Consequences

- CSP, ACP, local CLI, and relayer APIs remain behaviorally unchanged.
- A remote user needs no Git repository, local folder, CLI, Node.js, or local
  MCP process.
- The service must earn its own public security review, client validation, and
  deployment hardening in later PRs.
- PR 1 supplies no listener, endpoint, deployment image, or public claim that
  the service is available.

