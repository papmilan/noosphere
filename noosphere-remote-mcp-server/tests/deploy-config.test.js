import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Lightweight guard for the merge-gate Compose fix: every documented invocation
// that targets deploy/docker-compose.yml must pass `--env-file deploy/noosphere.env`.
// Compose resolves the file's `${VAR:?}` guards during interpolation, which reads
// only `--env-file` (or the project-directory `.env`) — never a service `env_file:`.
// Drop the flag anywhere and the reference stack stops booting as documented.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const DOCS = [
  'docs/remote-mcp/DEPLOYMENT.md',
  'docs/remote-mcp/OPERATIONS.md',
  'deploy/docker-compose.yml',
];

// Match a `docker compose ...` command up to end-of-line / line-continuation that
// references the deploy compose file, so we only assert on the stack's own commands.
const COMPOSE_CMD = /docker compose\b[^\n]*-f deploy\/docker-compose\.yml[^\n]*/g;

test('every documented deploy-stack compose command uses --env-file deploy/noosphere.env', () => {
  let checked = 0;
  for (const rel of DOCS) {
    const text = readFileSync(join(repoRoot, rel), 'utf8');
    for (const match of text.matchAll(COMPOSE_CMD)) {
      checked += 1;
      assert.ok(
        match[0].includes('--env-file deploy/noosphere.env'),
        `${rel}: compose command missing "--env-file deploy/noosphere.env":\n  ${match[0]}`,
      );
    }
  }
  // Guard against the regex silently matching nothing (e.g. a path rename).
  assert.ok(checked >= 2, `expected to find documented compose commands, found ${checked}`);
});
