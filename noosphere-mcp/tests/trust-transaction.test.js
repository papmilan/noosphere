import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { createTrustTestHarness } from './helpers/trust-test-harness.js';

const temporary = [];
after(async () => { await Promise.all(temporary.map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-phase4a-home-'));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-phase4a-project-'));
  temporary.push(home, project);
  const env = { NOOSPHERE_HOME: home, NOOSPHERE_OWNER_SCOPE: 'phase4-owner' };
  const harness = createTrustTestHarness({ env });
  const binding = await harness.createProjectBinding(project);
  return { harness, binding, project };
}

describe('SEC-05 Phase 4A-R1 — serialized immutable transactions', () => {
  it('commits one record, audit event, and matching manifest atomically', async () => {
    const { harness, binding } = await fixture();
    const committed = await harness.commitTestTransaction({ binding, slot: 'master-prompt', rawBytes: 'approved bytes' });
    assert.equal(committed.record.generation, 1);
    assert.equal((await harness.readManifest(binding, 'master-prompt')).currentRecordId, committed.record.recordId);
    assert.equal(await harness.isFormat2Authoritative({ binding, slot: 'master-prompt', rawBytes: 'approved bytes' }), true);
  });

  it('serializes contenders and never lets the loser reuse a generation', async () => {
    const { harness, binding } = await fixture();
    const held = await harness.acquireLock(binding, 'master-prompt', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    await assert.rejects(
      harness.commitTestTransaction({ binding, slot: 'master-prompt', rawBytes: 'other' }),
      (error) => error.code === 'trust-lock-busy',
    );
    await held.release();
    const first = await harness.commitTestTransaction({ binding, slot: 'master-prompt', rawBytes: 'first' });
    const second = await harness.commitTestTransaction({ binding, slot: 'master-prompt', rawBytes: 'second' });
    assert.deepEqual([first.record.generation, second.record.generation], [1, 2]);
    assert.equal(await harness.isFormat2Authoritative({ binding, slot: 'master-prompt', rawBytes: 'first' }), false);
    assert.equal(await harness.isFormat2Authoritative({ binding, slot: 'master-prompt', rawBytes: 'second' }), true);
  });

  for (const phase of ['journal-prepared', 'record-created', 'audit-event-created', 'manifest-committed']) {
    it(`fails closed after a simulated crash at ${phase}`, async () => {
      const { harness, binding } = await fixture();
      await assert.rejects(
        harness.commitTestTransaction({ binding, slot: 'master-prompt', rawBytes: 'candidate', crashAt: phase }),
        (error) => error.code === 'simulated-crash',
      );
      await harness.recover(binding, 'master-prompt');
      assert.equal(await harness.isFormat2Authoritative({ binding, slot: 'master-prompt', rawBytes: 'candidate' }), phase === 'manifest-committed');
    });
  }

  it('does not reclaim a live lock and release verifies the owner token', async () => {
    const { harness, binding } = await fixture();
    const lock = await harness.acquireLock(binding, 'master-prompt', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    await assert.rejects(lock.release('cccccccc-cccc-4ccc-8ccc-cccccccccccc'), (error) => error.code === 'trust-lock-not-owner');
    await assert.rejects(harness.recover(binding, 'master-prompt'), (error) => error.code === 'trust-lock-live');
    await lock.release();
  });
});
