import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { MAX_TRUST_RECORD_BYTES } from '../continuity/trust-store-internal.js';
import { createTrustTestHarness } from './helpers/trust-test-harness.js';

const temporary = [];
after(async () => { await Promise.all(temporary.map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

async function fresh() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-phase4a-home-'));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-phase4a-project-'));
  temporary.push(home, project);
  return { home, project, env: { NOOSPHERE_HOME: home, NOOSPHERE_OWNER_SCOPE: 'phase4-owner' } };
}

describe('SEC-05 Phase 4A-R1 — strict machine-key and bounded authenticated inputs', () => {
  for (const [name, content] of Object.entries({
    uppercase: 'A'.repeat(64),
    'odd length': 'a'.repeat(63),
    'non-hex': `${'a'.repeat(63)}g`,
    'embedded NUL': `${'a'.repeat(31)}\0${'a'.repeat(32)}`,
    'trailing junk': `${'a'.repeat(64)}x`,
    'additional line': `${'a'.repeat(64)}\nextra\n`,
  })) {
    it(`rejects ${name} machine-key material without overwriting it`, async () => {
      const { home, env } = await fresh();
      const file = path.join(home, 'machine-key');
      await fs.writeFile(file, content, { mode: 0o600 });
      const harness = createTrustTestHarness({ env });
      await assert.rejects(harness.ensureMachineKey(), (error) => error.code === 'machine-key-corrupt');
      assert.equal(await fs.readFile(file, 'utf8'), content);
    });
  }

  it('accepts exactly 64 lowercase hex characters with one terminal newline', async () => {
    const { home, env } = await fresh();
    const material = 'ab'.repeat(32);
    await fs.writeFile(path.join(home, 'machine-key'), `${material}\n`, { mode: 0o600 });
    const key = await createTrustTestHarness({ env }).ensureMachineKey();
    assert.equal(key.toString('hex'), material);
  });

  it('rejects exact-size-plus-one immutable inputs before parsing', async () => {
    const { env, project } = await fresh();
    const harness = createTrustTestHarness({ env });
    const binding = await harness.createProjectBinding(project);
    const file = harness.pathFor(binding, 'records/master-prompt/1-11111111-1111-4111-8111-111111111111.json');
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, 'x'.repeat(MAX_TRUST_RECORD_BYTES + 1), { mode: 0o600 });
    await assert.rejects(harness.readImmutableRecord(file), (error) => error.code === 'record-too-large');
  });

  it('rejects oversized bindings and manifests before parsing', async () => {
    const { env, project } = await fresh();
    const harness = createTrustTestHarness({ env });
    const binding = await harness.createProjectBinding(project);
    await fs.writeFile(harness.bindingPath(project), 'x'.repeat(MAX_TRUST_RECORD_BYTES + 1), { mode: 0o600 });
    await assert.rejects(harness.readProjectBinding(project), (error) => error.code === 'record-too-large');
    await fs.mkdir(path.dirname(harness.manifestPath(binding, 'master-prompt')), { recursive: true, mode: 0o700 });
    await fs.writeFile(harness.manifestPath(binding, 'master-prompt'), 'x'.repeat(MAX_TRUST_RECORD_BYTES + 1), { mode: 0o600 });
    await assert.rejects(harness.readManifest(binding, 'master-prompt'), (error) => error.code === 'record-too-large');
  });
});
