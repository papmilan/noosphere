# Contributing to Noosphere

Thanks for considering a contribution. This document covers how to set up a
development environment, what a change is expected to include, and how
review works.

For security problems, do not open an issue — follow
[SECURITY.md](SECURITY.md).

## Repository layout

This is a small monorepo with three packages:

| Directory | npm package | What it is |
| --- | --- | --- |
| `noosphere-mcp/` | `noosphere-continuity` | CLI, watcher, lifecycle installer, CSP task state, ACP handoff state |
| `noosphere-relayer/` | `noosphere-relayer` | HTTP memory relay server |
| `noosphere-acp-protocol/` | `@noosphere/acp-protocol` | Shared ACP envelopes, schemas, validation (bundled, not published separately) |

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
```

The `noosphere-mcp` tests boot the relayer from its sibling directory, so
both installs are required even for CLI-only changes.

## Running checks and tests

Each package has a `check` script (syntax checks plus the full test suite)
and a `test` script:

```sh
npm --prefix noosphere-acp-protocol test
npm --prefix noosphere-relayer run check
npm --prefix noosphere-mcp run check
```

Run all three before opening a pull request. The MCP suite is serialized
(`--test-concurrency=1`) on purpose; do not parallelize it.

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
- relayer routes/queue/security → `noosphere-relayer/tests/`;
- CLI, watcher, lifecycle, CSP task state, ACP handoff state →
  `noosphere-mcp/tests/`.

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
