import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import { classifyLockLiveness } from '../continuity/internal/restore/recovery.js';
import { createFormatV2Store } from '../continuity/internal/trust-format-v2.js';
import {
  BOUNDARIES,
  REPLACED,
  clearSlotLockAsOwner,
  cli,
  crash,
  fixture,
  stateOf,
} from './helpers/restore-recovery-cli-fixture.js';

// SEC-05 Phase 4C, Finding 1 remediation — crash recovery in the production path.
//
// Every test here drives the REAL CLI as a subprocess. Nothing imports
// recovery.js to make recovery happen: if the production wiring is removed or
// reordered, these fail, which is the whole point. (recovery.js is imported for
// read-only assertions and for classifyLockLiveness, never to trigger a repair.)
describe('SEC-05 Phase 4C — crash recovery through the production CLI', () => {
  for (const boundary of BOUNDARIES) {
    it(`recovers a SIGKILL at ${boundary} after the owner clears its slot lock`, async () => {
      const context = await fixture();
      crash(context, boundary);

      // The crash left a held lock. Nothing has been recovered yet.
      const store = createFormatV2Store({ env: context.env });
      const binding = await store.readProjectBinding(context.projectRoot);
      const held = await store.inspectLock(binding, 'baseline');
      assert.notEqual(held, null, 'a real crash must leave the slot lock held');
      assert.equal(classifyLockLiveness(held), 'abandoned');

      const refused = cli(context, ['recover']);
      assert.equal(refused.status, 4);
      assert.match(refused.stderr, /slot lock is present/);
      assert.notEqual(await store.inspectLock(binding, 'baseline'), null);

      await clearSlotLockAsOwner(context);
      const recovered = cli(context, ['recover']);
      assert.equal(recovered.status, 0, `restore recover failed: ${recovered.stderr}`);
      assert.match(recovered.stdout, /no destination was replaced twice/);

      const after = await stateOf(context);
      assert.equal(after.journal.state, 'complete');
      assert.equal(after.journal.outcome, REPLACED.has(boundary) ? 'applied' : 'failed');
      assert.equal(after.candidate.state, 'consumed');
      assert.equal(
        after.bytes.toString('utf8'),
        REPLACED.has(boundary) ? context.content : 'before',
      );
      assert.equal(await store.inspectLock(binding, 'baseline'), null, 'the lock was not released');
      const temporaryPath = path.join(context.projectRoot, ...after.journal.temporaryPath.split('/'));
      await assert.rejects(fs.access(temporaryPath), 'the temporary file survived recovery');
    });
  }
});
