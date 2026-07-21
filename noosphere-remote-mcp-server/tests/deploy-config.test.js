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
  const checkedByDoc = new Map();
  for (const rel of DOCS) {
    const text = readFileSync(join(repoRoot, rel), 'utf8');
    // Join shell line-continuations so a command split across lines is scanned whole.
    const normalized = text.replace(/\\\r?\n[ \t]*/g, ' ');
    for (const match of normalized.matchAll(COMPOSE_CMD)) {
      checkedByDoc.set(rel, (checkedByDoc.get(rel) ?? 0) + 1);
      assert.ok(
        match[0].includes('--env-file deploy/noosphere.env'),
        `${rel}: compose command missing "--env-file deploy/noosphere.env":\n  ${match[0]}`,
      );
    }
  }
  // Every listed source must contribute at least one match, so a path rename or
  // silent regex miss in any single file fails the guard (not masked by others).
  for (const rel of DOCS) {
    assert.ok(checkedByDoc.has(rel), `${rel}: expected at least one documented compose command`);
  }
});
