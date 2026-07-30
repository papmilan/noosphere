import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not `new URL(...).pathname`: on Windows the URL path is
// `/D:/...`, which path.resolve turns into `D:\D:\...`.
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

test('package exports no replay writer or replay-key operation', async () => {
  const manifest = JSON.parse(await fs.readFile(
    path.join(packageRoot, 'package.json'),
    'utf8',
  ));
  assert.deepEqual(Object.keys(manifest.exports).sort(), [
    './package.json',
    './trust-store',
  ]);
  const trustStore = await import('../continuity/trust-store.js');
  assert.deepEqual(Object.keys(trustStore).sort(), [
    'PHASE1_NORM_ALGO',
    'PHASE1_NORM_VERSION',
    'TRUST_SLOTS',
    'TrustStoreError',
    'isSlotAuthoritative',
  ]);
  for (const specifier of [
    'noosphere-continuity/continuity/internal/replay/observe.js',
    'noosphere-continuity/continuity/internal/replay/operation.js',
    'noosphere-continuity/continuity/internal/replay/key.js',
    'noosphere-continuity/continuity/internal/replay/restore-stage.js',
  ]) {
    await assert.rejects(
      import(specifier),
      error => error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
    );
  }
});

test('MCP, hooks, lifecycle, adapters, and relayer expose no replay mutation', async () => {
  const roots = [
    path.join(packageRoot, 'mcp-server'),
    path.join(packageRoot, 'hooks'),
    path.join(packageRoot, 'lifecycle'),
    path.resolve(packageRoot, '..', 'noosphere-relayer'),
  ];
  const forbidden = [
    'observeReplay',
    'withReplayOperation',
    'commitReplayJournalTransaction',
    'applyReplayRetention',
    'ensureReplayKey',
    'stageReplayAwareRestoreCandidate',
  ];
  for (const root of roots) {
    for (const file of await fs.readdir(root, { recursive: true })) {
      const absolute = path.join(root, file);
      if (!/\.(?:js|mjs|cjs|json)$/.test(file) ||
          !(await fs.stat(absolute)).isFile()) continue;
      const source = await fs.readFile(absolute, 'utf8');
      for (const name of forbidden) {
        assert.equal(source.includes(name), false, `${path.join(root, file)} exposes ${name}`);
      }
    }
  }
});
