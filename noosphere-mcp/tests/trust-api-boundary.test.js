import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
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

  it('keeps the test-only authority harness out of the packed package', async () => {
    // Reuse the package's own npm-shim helpers: on Windows npm is npm.cmd and
    // Node refuses to spawn .cmd without shell:true (CVE-2024-27980 mitigation).
    const packed = JSON.parse(execFileSync(npmCommand(), ['pack', '--dry-run', '--json', '--cache', path.join(os.tmpdir(), 'noosphere-npm-cache')], { cwd: packageRoot, encoding: 'utf8', ...npmSpawnOptions() }));
    const names = packed[0].files.map((entry) => entry.path);
    assert.equal(names.some((name) => name.includes('trust-test-harness')), false);
    assert.equal(names.some((name) => name.startsWith('tests/')), false);
    // The internal primitives DO ship, so a future trusted in-process service can import them.
    for (const shipped of ['continuity/internal/trust-format-v2.js', 'continuity/internal/strict-schema.js']) {
      assert.equal(names.includes(shipped), true, `${shipped} must ship for Phase 4B`);
    }
    // …and the one supported entry point must ship too, or the export map is a lie.
    const { exports: map } = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    assert.deepEqual(Object.keys(map).sort(), ['./package.json', './trust-store']);
    assert.equal(names.includes(map['./trust-store'].replace('./', '')), true);
  });

  // SEC-05 Phase 4A-R3 (remediation §17): closing the writer boundary must not
  // break the one supported entry point. Consumers reach it by package specifier,
  // which resolves through the export map — the same map in the packed artifact,
  // since package.json ships verbatim.
  it('resolves the supported entry point from ESM and CommonJS', async () => {
    const module = await import('noosphere-continuity/trust-store');
    // Exact allowlist, not a name denylist: a future writer would simply be a name
    // no pattern anticipated (ensureMachineKey, mintRecord, …), so the assertion
    // has to be "these five and nothing else" to actually hold the boundary.
    assert.deepEqual(Object.keys(module).sort(), [
      'PHASE1_NORM_ALGO',
      'PHASE1_NORM_VERSION',
      'TRUST_SLOTS',
      'TrustStoreError',
      'isSlotAuthoritative',
    ]);
    assert.equal(typeof module.isSlotAuthoritative, 'function');

    const require = createRequire(path.join(packageRoot, 'noop.cjs'));
    assert.equal(
      require.resolve('noosphere-continuity/trust-store'),
      path.join(packageRoot, 'continuity', 'trust-store.js'),
    );
  });

  it('does not expose a package-root entry point', async () => {
    await assert.rejects(import('noosphere-continuity'), (error) => error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED');
    const require = createRequire(path.join(packageRoot, 'noop.cjs'));
    assert.throws(() => require.resolve('noosphere-continuity'), (error) => error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED');
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
