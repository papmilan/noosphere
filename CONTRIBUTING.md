# Contributing to Noosphere

Thanks for considering a contribution. This document covers how to set up a
development environment, what a change is expected to include, and how
review works.

For security problems, do not open an issue — follow
[SECURITY.md](SECURITY.md).

## Repository layout

This monorepo contains the released continuity/relayer pair and the shared and
Project Memory components they use:

| Directory | npm package | What it is |
| --- | --- | --- |
| `noosphere-mcp/` | `noosphere-continuity` | CLI, watcher, lifecycle installer, CSP task state, ACP handoff state |
| `noosphere-relayer/` | `noosphere-relayer` | HTTP memory relay server |
| `noosphere-acp-protocol/` | `@noosphere/acp-protocol` | Shared ACP envelopes, schemas, validation (bundled, not published separately) |
| `noosphere-secure-fs/` | `@noosphere/secure-fs` | Shared secure persistence and Windows owner-ACL boundary |
| `noosphere-remote-mcp/` | `@noosphere/remote-mcp-contracts` | Project Memory schemas, repository contract, and service core |
| `noosphere-remote-mcp-postgres/` | `@noosphere/remote-mcp-postgres` | PostgreSQL repository, OIDC verifier, and migrations |
| `noosphere-remote-mcp-server/` | `@noosphere/remote-mcp-server` | Streamable HTTP MCP transport and production entry point |
| `noosphere-local-mcp/` | `@noosphere/local-mcp` | Single-user, durable STDIO MCP transport |
| `noosphere-remote-mcp-acceptance/` | `@noosphere/remote-mcp-acceptance` | Cross-client and transport acceptance tests |

`noosphere-relayer/vendor/acp-protocol/` is a byte-identical mirror of
`noosphere-acp-protocol/` kept for the Docker build context. If you change
the protocol package, copy the change into the vendor mirror;
`noosphere-mcp/tests/distribution.test.js` fails on any drift.

## Development setup

Requirements: Node.js 22 or newer, npm, git. There is no build step and no
transpiler — the packages are plain ES modules.

```sh
git clone https://github.com/papmilan/noosphere.git
cd noosphere

npm --prefix noosphere-relayer install
npm --prefix noosphere-mcp install
npm --prefix noosphere-remote-mcp-postgres install
npm --prefix noosphere-remote-mcp-server install
npm --prefix noosphere-local-mcp install
npm --prefix noosphere-remote-mcp-acceptance install
```

Several suites load sibling package source. The `noosphere-mcp` and relayer
suites need one another's dependencies. The remote server, Local STDIO, and
acceptance suites also load the PostgreSQL OIDC/server packages. Install the
siblings shown above before interpreting a missing-module failure as a product
failure.

## Running checks and tests

Run the gate owned by every package you changed:

```sh
npm --prefix noosphere-acp-protocol test
npm --prefix noosphere-secure-fs run check
npm --prefix noosphere-relayer run check
npm --prefix noosphere-mcp run check
npm --prefix noosphere-remote-mcp test
npm --prefix noosphere-remote-mcp-server test
npm --prefix noosphere-local-mcp test
npm --prefix noosphere-remote-mcp-acceptance test
npm --prefix noosphere-remote-mcp-postgres run test:nodb
```

PostgreSQL integration tests need the disposable development database:

```sh
npm --prefix noosphere-remote-mcp-postgres run db:up
npm --prefix noosphere-remote-mcp-postgres run migrate
npm --prefix noosphere-remote-mcp-postgres run test:db
npm --prefix noosphere-remote-mcp-postgres run db:down
```

`db:down` removes that Compose database volume. The continuity suite is
serialized (`--test-concurrency=1`) on purpose; do not parallelize it.

Live Walrus tests (`npm --prefix noosphere-relayer run test:live`) need real
credentials and are not required for contributions.

## Coding standards

- Plain modern JavaScript (ES modules, Node 22+). No TypeScript, no build
  step, no new runtime dependencies without prior discussion in an issue.
- Match the style of the file you are editing. There is no linter config;
  the codebase favors small modules, explicit names, and early validation.
- Comments state constraints the code cannot express — not what the next
  line does.
- Security-sensitive paths (credentials, ACP validation, quarantine, HTTP
  auth) fail closed. Keep it that way.

## Tests

Every behavior change comes with a test in the package it touches:

- protocol changes → `noosphere-acp-protocol/tests/` plus the vendor mirror
  sync;
- shared persistence changes → `noosphere-secure-fs/tests/` plus every affected
  consumer's security suite;
- relayer routes/queue/security → `noosphere-relayer/tests/`;
- CLI, watcher, lifecycle, CSP task state, ACP handoff state →
  `noosphere-mcp/tests/`;
- Project Memory contracts/core → `noosphere-remote-mcp/tests/`;
- remote auth/transport → `noosphere-remote-mcp-server/tests/`;
- database semantics → no-DB parity and PostgreSQL-backed tests in
  `noosphere-remote-mcp-postgres/tests/`;
- Local STDIO behavior → `noosphere-local-mcp/tests/`;
- cross-transport/client promises → `noosphere-remote-mcp-acceptance/tests/`.

Bug fixes include a regression test that fails without the fix.

## Commits and pull requests

- Conventional commit subjects, as in the existing history:
  `feat: …`, `fix: …`, `docs: …`, `test: …`, `chore: …`. Imperative mood,
  lower case, no trailing period.
- One logical change per commit; small PRs review faster.
- The PR description states what changed, why, and how it was verified
  (paste the test summary lines).
- Do not bump package versions in a feature PR — releases are separate
  commits made by the maintainer.

## Review process

A maintainer reviews every PR. Expect questions about failure modes and
trust boundaries — ACP was built through adversarial review (see
[docs/design/](docs/design/)), and changes to validation, sync, or
credential handling get the same treatment. CI must be green; if a check
fails for a reason unrelated to your change, say so in the PR.

## What gets accepted

This project is deliberately conservative in scope. Good candidates:

- bug fixes with regression tests;
- documentation corrections;
- portability fixes (Windows, Linux, macOS);
- test coverage for existing behavior.

New features, new dependencies, or protocol changes: open an issue first
and wait for a design discussion before writing code.
