# Remote Project Memory Delivery Plan

> This plan starts only after explicit approval for the next PR. PR 1 supplies
> contracts, not a usable remote service.

## PR 2 — pure Project Memory core

Implement project matching, checkpoint revision creation, summaries, session
transitions, archive/delete semantics, and resume freshness using the
in-memory repository. Begin each behavior with a failing unit test. Verify
ambiguous names never select a project, revision/predecessor consistency holds,
and no operation requires Git or a local folder.

## PR 3 — PostgreSQL tenancy and OIDC

Add migrations, a transactional PostgreSQL repository, owner-scoped queries,
quota/retention configuration, export/deletion jobs, and a provider-neutral
OIDC verifier. Test issuer, audience, expiry, scope, cross-owner isolation,
idempotency races, unavailable storage, and a production configuration that
rejects the test identity injector.

## PR 4 — remote MCP server

Add an independent Streamable HTTP service with protected-resource metadata,
Origin validation, request correlation/redaction, health/readiness, graceful
shutdown, and tool handlers. Do not add local filesystem access or import
existing relayer runtime. Test MCP initialize/list/call errors and retry-safe
tool calls.

## PR 5 — cross-client continuity acceptance

Run protocol-client acceptance tests and validate ChatGPT and Claude only on
specific account/workspace/client configurations that support the selected
transport and OAuth flow. Cover Bicycle Repair and Architecture Phase 1→2,
separate projects, ambiguity, interrupted sessions, and cross-user denial.
Do not claim universal client support.

## PR 6 — deployment and user documentation

Add a production image, EU-region reference configuration, database
initialization/migration runbook, OIDC setup, privacy/retention/delete/export
documentation, and supported-client setup. Verify the image, dependency
audits, package boundaries, and real deployment health/readiness.

## Global verification

Every later PR must retain CSP/ACP compatibility, test untrusted stored content
handling, prohibit hidden reasoning/transcript capture, and demonstrate that
the remote service does not require a Git repository, local folder, CLI, or
user-run MCP process.

