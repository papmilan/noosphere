# ADR 0005: Authenticate Remote Project Memory Through Provider-Neutral OIDC

- **Status:** Accepted
- **Date:** 2026-07-19
- **Decision owners:** Noosphere maintainers

## Context

Remote MCP clients need per-user authorization. A user ID submitted to a tool
would permit insecure direct object reference attacks. Binding Noosphere to one
identity vendor would unnecessarily constrain self-hosted and managed
deployments.

## Decision

Treat the remote MCP service as an OAuth 2.1 protected resource. A
provider-neutral verifier validates issuer, audience, signature/key material,
expiry, and required scopes, then derives the owner scope from the verified
subject. The resource server publishes protected-resource metadata and expects
an authorization server with standard authorization-server metadata.

Production never enables test identities. A local test identity injector is
permitted only when an explicit development-only configuration is validated and
production configuration rejects it.

## Consequences

- No public tool contract accepts owner, tenant, user, subject, token, or
  authorization values.
- Authentication failures disclose neither project names nor ownership.
- Selecting an OIDC vendor or local Keycloak example is deployment work for a
  later PR, not a product dependency in PR 1.
