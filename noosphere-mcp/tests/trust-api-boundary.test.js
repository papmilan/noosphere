import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

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
    // Windows exposes npm as npm.cmd; execFileSync without a shell cannot spawn a
    // bare `npm`, so resolve the platform-correct executable name.
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const packed = JSON.parse(execFileSync(npmCmd, ['pack', '--dry-run', '--json', '--cache', path.join(os.tmpdir(), 'noosphere-npm-cache')], { cwd: packageRoot, encoding: 'utf8' }));
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
