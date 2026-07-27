import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  classifyRestoreReceipt,
  commitConsumedMarker,
  commitRestoreReceipt,
  readConsumedMarker,
} from '../continuity/internal/restore/receipt-store.js';

const temporary = [];

after(async () => {
  await Promise.all(temporary.map(directory =>
    fs.rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-receipt-home-'));
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-receipt-project-'));
  temporary.push(home, projectRoot);
  const env = {
    NOOSPHERE_HOME: home,
    NOOSPHERE_OWNER_SCOPE: 'phase4c-owner',
  };
  const candidateId = 'a'.repeat(51) + 'q';
  const transactionId = '11111111-1111-4111-8111-111111111111';
  const contextId = '22222222-2222-4222-8222-222222222222';
  return {
    projectRoot,
    env,
    candidateId,
    transactionId,
    contextId,
    input: {
      projectRoot,
      env,
      receiptId: transactionId,
      transactionId,
      contextId,
      candidateId,
      candidatePayloadHash: '1'.repeat(64),
      destinationHash: '2'.repeat(64),
      slot: 'baseline',
      outcome: 'applied',
      authoritative: false,
    },
  };
}

describe('SEC-05 Phase 4C — restore receipts and consumed markers', () => {
  it('commits an immutable authenticated audit-only receipt', async () => {
    const context = await fixture();
    const receipt = await commitRestoreReceipt(context.input);
    assert.equal(receipt.receiptId, context.transactionId);
    assert.deepEqual(
      await classifyRestoreReceipt({
        projectRoot: context.projectRoot,
        env: context.env,
        receiptId: context.transactionId,
      }),
      {
        classification: 'audit-only',
        slot: 'baseline',
        outcome: 'applied',
        destinationHash: '2'.repeat(64),
        transactionId: context.transactionId,
        authoritative: false,
      },
    );
    assert.deepEqual(await commitRestoreReceipt(context.input), receipt);
  });

  it('commits an independent authenticated consumed marker and rejects tampering', async () => {
    const context = await fixture();
    const marker = await commitConsumedMarker({
      ...context.input,
      outcome: 'failed-before-replacement',
      receiptId: null,
    });
    assert.equal(marker.candidateId, context.candidateId);
    assert.equal((await readConsumedMarker({
      projectRoot: context.projectRoot,
      env: context.env,
      candidateId: context.candidateId,
    })).outcome, 'failed-before-replacement');

    const bytes = await fs.readFile(marker.path, 'utf8');
    await fs.writeFile(marker.path, bytes.replace(
      'failed-before-replacement',
      'applied-before-replacement',
    ));
    await assert.rejects(
      readConsumedMarker({
        projectRoot: context.projectRoot,
        env: context.env,
        candidateId: context.candidateId,
      }),
      error => error.code === 'ERR_RESTORE_RECEIPT_INVALID',
    );
  });
});
