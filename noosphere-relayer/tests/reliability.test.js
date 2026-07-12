import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

  it('stops immediate retries when an upstream rate limit is detected', async () => {
    let attempts = 0;
    await assert.rejects(
      retryOperation(
        async () => {
          attempts += 1;
          throw new Error('Walrus server error (429): rate limit exceeded');
        },
        {
          attempts: 3,
          shouldRetry: (error) => !/429/.test(error.message),
          sleep: async () => {
            throw new Error('sleep should not run');
          },
        },
      ),
      /429/,
    );
    assert.equal(attempts, 1);
  });

  it('persists the next eligible retry time with a failed job', async () => {
    const filePath = path.join(temporaryRoot, 'retry-state.json');
    const store = new DurableStore({ filePath });
    await store.enqueue('project:delayed', {
      projectId: 'project',
      serializedRecord: 'pending',
      responseTemplate: { success: true },
    });
    await store.markAttempt('project:delayed', new Error('rate limited'), {
      nextAttemptAt: 123_456,
    });

    const restarted = new DurableStore({ filePath });
    const pending = await restarted.getPending('project:delayed');
    assert.equal(pending.attempts, 1);
    assert.equal(pending.nextAttemptAt, 123_456);
  });

  it('shares one initialization promise so concurrent callers cannot overwrite restarted state', async () => {
    const filePath = path.join(temporaryRoot, 'initialization-race.json');
    await writeFile(filePath, JSON.stringify({
      version: 1,
      receipts: {},
      pending: { existing: { key: 'existing', projectId: 'saved' } },
    }));
    const store = new DurableStore({ filePath });

    const [, existing] = await Promise.all([
      store.enqueue('new', { projectId: 'new' }),
      store.getPending('existing'),
    ]);

    assert.equal(existing.projectId, 'saved');
    assert.equal((await new DurableStore({ filePath }).getPending('existing')).projectId, 'saved');
  });
});
