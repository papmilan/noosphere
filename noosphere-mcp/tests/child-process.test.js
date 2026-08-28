import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { after, describe, it } from 'node:test';

import { testBudgetMs, waitForChild } from './child-process.js';

const children = [];

after(async () => {
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once('close', resolve);
          child.kill('SIGTERM');
        }),
    ),
  );
});

describe('child process test helper', () => {
  it('terminates a process that exceeds its timeout', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    children.push(child);

    await assert.rejects(
      () => waitForChild(child, ['watch'], { timeoutMs: 25 }),
      /Timed out after 25ms running noosphere watch/,
    );
  });

  it('waits for a timed-out child that ignores SIGTERM to close', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)",
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    children.push(child);
    await waitForOutput(child.stdout, 'ready');
    const closed = new Promise((resolve) => child.once('close', resolve));

    await assert.rejects(
      () =>
        waitForChild(child, ['watch'], {
          timeoutMs: 25,
          terminationGraceMs: 25,
        }),
      /Timed out after 25ms running noosphere watch/,
    );

    const outcome = await Promise.race([
      closed.then(() => 'closed'),
      delay(100).then(() => 'still-running'),
    ]);
    assert.equal(outcome, 'closed');
  });

  it('settles when a child never emits close after escalation', async () => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => true;

    const outcome = await Promise.race([
      waitForChild(child, ['watch'], {
        timeoutMs: 10,
        terminationGraceMs: 10,
        finalCleanupTimeoutMs: 10,
      }).then(
        (value) => ({ type: 'resolved', value }),
        (error) => ({ type: 'rejected', error }),
      ),
      delay(100).then(() => ({ type: 'still-running' })),
    ]);

    assert.equal(outcome.type, 'rejected');
    assert.match(outcome.error.message, /Timed out after 10ms running noosphere watch/);
  });
});

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitForOutput(stream, expected) {
  return new Promise((resolve) => {
    let output = '';
    stream.on('data', (chunk) => {
      output += chunk.toString();
      if (output.includes(expected)) resolve();
    });
  });
}

describe('testBudgetMs', () => {
  it('scales the budget on the slow platform and leaves others alone', () => {
    const env = {};
    assert.equal(testBudgetMs(8_000, { platform: 'linux', env }), 8_000);
    assert.equal(testBudgetMs(8_000, { platform: 'darwin', env }), 8_000);
    assert.equal(testBudgetMs(8_000, { platform: 'win32', env }), 32_000);
  });

  it('lets an explicit scale shrink a budget so a give-up path is provable', () => {
    // The reason for an override at all: proving a timeout fires should not
    // require waiting out the real budget.
    const env = { NOOSPHERE_TEST_TIMEOUT_SCALE: '0.01' };
    assert.equal(testBudgetMs(8_000, { platform: 'linux', env }), 80);
    // An explicit scale wins on every platform, including the slow one.
    assert.equal(testBudgetMs(8_000, { platform: 'win32', env }), 80);
  });

  it('ignores an unusable scale rather than producing a nonsense budget', () => {
    for (const value of ['0', '-1', 'soon', '', 'NaN', 'Infinity']) {
      assert.equal(
        testBudgetMs(8_000, { platform: 'linux', env: { NOOSPHERE_TEST_TIMEOUT_SCALE: value } }),
        8_000,
        `scale ${JSON.stringify(value)} should have fallen back`,
      );
    }
  });
});
