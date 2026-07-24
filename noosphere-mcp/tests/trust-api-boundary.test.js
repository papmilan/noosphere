import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { npmCommand, npmSpawnOptions } from '../lifecycle/util.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('SEC-05 Phase 4A-R1 — production writer boundary', () => {
  it('does not support deep imports of trust writers', async () => {
    await assert.rejects(
      import('noosphere-continuity/continuity/trust-store-internal.js'),
      (error) => error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
    );
  });

  it('does not support deep imports of the internal format-2 primitives', async () => {
    for (const specifier of [
      'noosphere-continuity/continuity/internal/trust-format-v2.js',
      'noosphere-continuity/continuity/internal/strict-schema.js',
    ]) {
      await assert.rejects(import(specifier), (error) => error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED');
    }
  });

  it('keeps the test-only authority harness out of the packed package', () => {
    // Reuse the package's own npm-shim helpers: on Windows npm is npm.cmd and
    // Node refuses to spawn .cmd without shell:true (CVE-2024-27980 mitigation).
    const packed = JSON.parse(execFileSync(npmCommand(), ['pack', '--dry-run', '--json', '--cache', path.join(os.tmpdir(), 'noosphere-npm-cache')], { cwd: packageRoot, encoding: 'utf8', ...npmSpawnOptions() }));
    const names = packed[0].files.map((entry) => entry.path);
    assert.equal(names.some((name) => name.includes('trust-test-harness')), false);
    assert.equal(names.some((name) => name.startsWith('tests/')), false);
    // The internal primitives DO ship, so a future trusted in-process service can import them.
    assert.equal(names.some((name) => name.includes('continuity/internal/trust-format-v2.js')), true);
  });

  it('has no production import of the Phase 4A test writer', async () => {
    for (const dir of ['continuity', 'continuity/internal']) {
      const abs = path.join(packageRoot, dir);
      const files = await fs.readdir(abs);
      for (const name of files.filter((entry) => entry.endsWith('.js'))) {
        const source = await fs.readFile(path.join(abs, name), 'utf8');
        assert.equal(source.includes('trust-test-harness'), false, `${dir}/${name} imports a test-only writer`);
      }
    }
  });
});
