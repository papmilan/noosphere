# Remote Project Memory Contracts Design

## Goal

Define remote, model-independent durable project memory for conversation-based
work without changing CSP, ACP, the local CLI, or the existing relayer.

## Model

A Project is a logical work unit. A Session records one client/model interaction
period. A Checkpoint is one immutable structured durable state record. Projects
may be software, research, planning, travel, or personal work; they have no
Git or directory requirement.

## Contract decisions

- Schema version: `noosphere.project-memory/1.0.0`.
- IDs are opaque UUID-like strings and do not authorize access.
- Owner scope is authenticated server context only.
- Project name matching is exact ID, normalized name, alias, then bounded text
  search ordered by activity. More than one plausible result is an ambiguity.
- A checkpoint is revisioned and points only to the immediately prior
  checkpoint of the same project. There is no semantic merge in v1.
- Archive hides a project from default listings; deletion is a separate,
  explicit lifecycle operation that removes related sessions, checkpoints, and
  idempotency records according to configurable retention policy.
- Returned state carries `content_trust: "untrusted-persisted-data"`.

## Explicit exclusions

No hidden chain-of-thought, automatic full transcript, browser scraping,
attachments, remote URL fetches, model-private context, public sharing,
collaborative editing, billing, or artifact provider is part of v1.

## Compatibility

CSP and ACP are not transported through this schema. A future client may cite
an ACP object as user-visible evidence, but Project Memory does not reinterpret
or mutate ACP/CSP fields.

## Delivery sequence

PR 1 defines contracts and tests. PR 2 implements pure service transitions and
matching. PR 3 adds PostgreSQL tenancy and OIDC verification. PR 4 adds the
remote MCP endpoint. PR 5 validates cross-client workflows. PR 6 adds
deployment and user documentation.
