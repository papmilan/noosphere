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
    // Bound the wait: a regression that never reaches the crash hook must fail
    // this test explicitly, not block the single-concurrency suite until the
    // global timeout. A timeout surfaces as result.error (asserted below).
    timeout: 30000,
    killSignal: 'SIGKILL',
  });
  return result;
}

// A crash child must be forcibly terminated, never exit cleanly and never fail to
// spawn / time out. On POSIX self-SIGKILL is observable as signal 'SIGKILL'; on
// Windows TerminateProcess surfaces as a non-zero status (no POSIX signal).
function assertKilled(result) {
  assert.equal(result.error, undefined, `child spawn errored or timed out: ${result.error?.message}`);
  assert.ok(result.signal === 'SIGKILL' || result.status !== 0, `child must be forcibly terminated (signal=${result.signal}, status=${result.status})`);
  if (process.platform !== 'win32') assert.equal(result.signal, 'SIGKILL', `POSIX crash must be an uncatchable SIGKILL (signal=${result.signal})`);
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
      assertKilled(result);

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

  it('rejects a well-formed foreign-owner lock during recovery (fail-closed, no reclaim)', async () => {
    const { harness, binding } = await fixture();
    const { hmac, machineKeyId, nowIso, writeExclusive } = harness._internal;
    const machineKey = await harness.ensureMachineKey();
    const transactionId = crypto.randomUUID();
    // A complete, MAC-valid lock under THIS machine key but a different owner: it
    // must reach and fail the ownership check as trust-lock-foreign, not bail out
    // early as malformed.
    const fields = { format: 2, type: 'trust-lock', transactionId, projectIdentity: binding.projectIdentity, ownerScope: 'someone-else', slot: SLOT, pid: 4242, startedAt: nowIso(), keyId: machineKeyId(machineKey) };
    const lock = { ...fields, mac: hmac(machineKey, 'trust-lock', fields), token: transactionId };
    await writeExclusive(harness.pathFor(binding, `locks/${SLOT}.lock`), lock);
    await assert.rejects(harness.inspectLock(binding, SLOT), (e) => e.code === 'trust-lock-foreign');
    await assert.rejects(harness.recover(binding, SLOT), (e) => e.code === 'trust-lock-foreign');
  });

  it('treats an unsafe (symlink) lock path as fail-closed, not absent', async () => {
    const { harness, binding } = await fixture();
    const lockFile = harness.pathFor(binding, `locks/${SLOT}.lock`);
    await fs.mkdir(path.dirname(lockFile), { recursive: true, mode: 0o700 });
    await fs.symlink(os.tmpdir(), lockFile);
    await assert.rejects(harness.inspectLock(binding, SLOT), (e) => e.code === 'trust-lock-unreadable');
    await assert.rejects(harness.recover(binding, SLOT), (e) => e.code === 'trust-lock-unreadable');
  });

  it('validates the slot before constructing lock/recovery paths', async () => {
    const { harness, binding } = await fixture();
    for (const bad of ['../../evil', 'master-prompt/../x', 'unknown-slot']) {
      await assert.rejects(harness.inspectLock(binding, bad), (e) => e.code === 'invalid-slot');
      await assert.rejects(harness.recover(binding, bad), (e) => e.code === 'invalid-slot');
    }
  });
});
