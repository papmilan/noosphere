import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { DurableStore, retryOperation } from '../durable-store.js';

describe('relayer reliability', () => {
  let temporaryRoot;

  before(async () => {
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), 'noosphere-reliability-'),
    );
  });

  after(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('recovers a pending upload after process-style restart', async () => {
    const filePath = path.join(temporaryRoot, 'state.json');
    const firstProcess = new DurableStore({ filePath });
    await firstProcess.enqueue('project:action', {
      projectId: 'project',
      serializedRecord: 'pending plaintext',
      responseTemplate: { success: true },
    });

    const restartedProcess = new DurableStore({ filePath });
    const pending = await restartedProcess.getPending('project:action');
    assert.equal(pending.projectId, 'project');
    assert.equal(pending.serializedRecord, 'pending plaintext');

    await restartedProcess.complete('project:action', {
      success: true,
      blob_id: 'blob',
    });
    const finalProcess = new DurableStore({ filePath });
    assert.equal(await finalProcess.getPending('project:action'), null);
    assert.equal(
      (await finalProcess.getReceipt('project:action')).blob_id,
      'blob',
    );
  });

  it('recovers after a simulated Walrus outage with exponential retry', async () => {
    const delays = [];
    let attempts = 0;
    const result = await retryOperation(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('Walrus unavailable');
        return 'stored';
      },
      {
        attempts: 3,
        baseDelayMs: 25,
        sleep: async (delay) => delays.push(delay),
      },
    );
    assert.equal(result, 'stored');
    assert.deepEqual(delays, [25, 50]);
  });
});
