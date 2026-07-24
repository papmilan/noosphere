import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { createTrustTestHarness } from './helpers/trust-test-harness.js';

const CHILD = fileURLToPath(new URL('./helpers/crash-child.mjs', import.meta.url));
const SLOT = 'master-prompt';
const temporary = [];
after(async () => { await Promise.all(temporary.map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-r2-home-'));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-r2-project-'));
  temporary.push(home, project);
  const env = { NOOSPHERE_HOME: home, NOOSPHERE_OWNER_SCOPE: 'r2-owner' };
  const harness = createTrustTestHarness({ env });
  const binding = await harness.createProjectBinding(project);
  return { harness, binding, home, project, env };
}

// Spawn the child and hard-kill it at `crashAt`. Returns once the process is dead.
function crash({ home, project, env }, crashAt, bytes) {
  const result = spawnSync(process.execPath, [CHILD], {
    cwd: path.dirname(path.dirname(CHILD)),
    env: { ...process.env, CRASH_HOME: home, CRASH_PROJECT: project, CRASH_SLOT: SLOT, CRASH_BYTES: bytes, CRASH_AT: crashAt, CRASH_SCOPE: env.NOOSPHERE_OWNER_SCOPE },
  });
  return result;
}

describe('SEC-05 Phase 4A-R2 — real process-death recovery', () => {
  for (const [boundary, expectAuthority] of [
    ['journal-prepared', false],
    ['record-created', false],
    ['audit-event-created', false],
    ['manifest-committed', true],
  ]) {
    it(`SIGKILL at ${boundary}: leaves a stale lock, recovers fail-closed, authority=${expectAuthority}`, async () => {
      const fx = await fixture();
      const { harness, binding } = fx;
      const result = crash(fx, boundary, 'candidate');
      assert.ok(result.signal === 'SIGKILL' || result.status !== 0, `child must be killed, not exit clean (signal=${result.signal} status=${result.status})`);

      // A real crash left the held lock on disk: recovery is fail-closed until the
      // owner intervenes (unlike the R1 exception tests, whose finally released it).
      const held = await harness.inspectLock(binding, SLOT);
      assert.notEqual(held, null, 'the crashed transaction lock must still be present');
      await assert.rejects(harness.recover(binding, SLOT), (e) => e.code === 'trust-lock-live');

      // Owner intervention: remove the authenticated stale lock, then recover.
      await fs.rm(harness.pathFor(binding, `locks/${SLOT}.lock`), { force: true });
      await harness.recover(binding, SLOT);
      assert.equal(await harness.isFormat2Authoritative({ binding, slot: SLOT, rawBytes: 'candidate' }), expectAuthority);

      // No orphan/partial state can be resurrected; a fresh commit takes the next
      // generation (2 if the crash committed generation 1, else 1) and verifies.
      const next = await harness.commitTestTransaction({ binding, slot: SLOT, rawBytes: 'after-recovery' });
      assert.equal(next.record.generation, expectAuthority ? 2 : 1);
      assert.equal(await harness.isFormat2Authoritative({ binding, slot: SLOT, rawBytes: 'after-recovery' }), true);
    });
  }

  it('rejects a foreign-owner lock during recovery (fail-closed, no reclaim)', async () => {
    const { harness, binding } = await fixture();
    // Hand-write a syntactically valid but foreign (unauthenticated) lock.
    await harness._internal.writeExclusive(harness.pathFor(binding, `locks/${SLOT}.lock`), { type: 'trust-lock', token: 'deadbeef-dead-4dea-8dea-deadbeefdead', mac: 'f'.repeat(64) });
    await assert.rejects(harness.inspectLock(binding, SLOT), (e) => e.code === 'trust-lock-malformed' || e.code === 'trust-lock-unauthenticated' || e.code === 'trust-lock-foreign');
    await assert.rejects(harness.recover(binding, SLOT), (e) => e.code && e.code.startsWith('trust-lock-'));
  });
});
