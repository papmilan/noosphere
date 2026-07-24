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
  const harness = createTrustTestHarness({ env: { NOOSPHERE_HOME: home, NOOSPHERE_OWNER_SCOPE: 'phase4-owner' } });
  return { harness, binding: await harness.createProjectBinding(project) };
}

describe('SEC-05 Phase 4A-R1 — authenticated append-only audit', () => {
  it('chains immutable events and rejects substitution or truncation', async () => {
    const { harness, binding } = await fixture();
    const first = await harness.commitTestTransaction({ binding, slot: 'master-prompt', rawBytes: 'one' });
    await harness.commitTestTransaction({ binding, slot: 'master-prompt', rawBytes: 'two' });
    assert.equal(await harness.verifyAuditChain(binding, 'master-prompt'), true);
    await fs.rm(harness.auditPath(binding, first.audit.eventId));
    assert.equal(await harness.isFormat2Authoritative({ binding, slot: 'master-prompt', rawBytes: 'two' }), false);
    assert.equal(await harness.verifyAuditChain(binding, 'master-prompt'), false);
  });

  it('does not let an audit event alone confer authority', async () => {
    const { harness, binding } = await fixture();
    await harness.writeOrphanAudit({ binding, slot: 'master-prompt', rawBytes: 'orphan' });
    assert.equal(await harness.isFormat2Authoritative({ binding, slot: 'master-prompt', rawBytes: 'orphan' }), false);
  });
});
