import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { classifyLockLiveness } from '../continuity/internal/restore/recovery.js';
import { createFormatV2Store } from '../continuity/internal/trust-format-v2.js';
import { stripComments } from './helpers/writer-surface.js';
import {
  cli,
  crash,
  fixture,
} from './helpers/restore-recovery-cli-fixture.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('SEC-05 Phase 4C — restore recovery lock policy', () => {
  // MUTATION TARGET: "delete a held lock unconditionally". Age is never a
  // reason; ownership and liveness are the only reasons.
  it('classifies liveness by process state alone, never by age or clock', () => {
    const live = { pid: process.pid, startedAt: new Date().toISOString() };
    assert.equal(classifyLockLiveness(live), 'live');
    // A PID that cannot exist is gone.
    assert.equal(classifyLockLiveness({ ...live, pid: 0x7ffffff }), 'abandoned');

    // HOSTILE REVIEW, finding 2: a lock whose startedAt is arbitrarily old, or
    // arbitrarily in the future, must not move the verdict at all. The previous
    // implementation declared a lock older than the machine's uptime abandoned,
    // which a forward clock jump turns into reclaiming a LIVE lock.
    for (const startedAt of [
      new Date(0).toISOString(),
      new Date(Date.now() - 365 * 86400_000).toISOString(),
      new Date(Date.now() + 365 * 86400_000).toISOString(),
      undefined,
      'not-a-date',
    ]) {
      assert.equal(
        classifyLockLiveness({ ...live, startedAt }),
        'live',
        `startedAt=${startedAt} changed a LIVE verdict`,
      );
    }

    // Only the PID shape can make it ambiguous.
    for (const broken of [{}, { pid: undefined }, { pid: -1 }, { pid: 0 }, { pid: 1.5 }, { pid: '1234' }]) {
      assert.equal(classifyLockLiveness(broken), 'ambiguous',
        `${JSON.stringify(broken)} must be ambiguous`);
    }
  });

  // HOSTILE REVIEW, finding 3: os.uptime() throws EPERM under some sandboxes
  // and container profiles. The classifier must not depend on it — or on any
  // other host call that can refuse.
  it('depends on no host call that can refuse', async () => {
    const source = stripComments(await fs.readFile(
      path.join(packageRoot, 'continuity/internal/restore/recovery.js'), 'utf8',
    ));
    assert.equal(/\bos\.uptime\s*\(/.test(source), false,
      'recovery reads os.uptime(), which throws EPERM under some sandboxes');
    assert.equal(/from 'node:os'/.test(source), false,
      'recovery imports node:os again — the liveness verdict must not depend on host state');
    // The classifier takes no options at all now, so nothing can steer it.
    assert.equal(classifyLockLiveness.length, 1, 'classifyLockLiveness regained a steerable parameter');
  });

  // HOSTILE REVIEW, finding 2: the liveness decision must not be steerable by a
  // caller-supplied clock, and there must be no clock in it to steer.
  it('exposes no clock or host seam the caller can steer', async () => {
    const source = stripComments(await fs.readFile(
      path.join(packageRoot, 'continuity/internal/restore/recovery.js'), 'utf8',
    ));
    const mentions = [...source.matchAll(/classifyLockLiveness\s*\(/g)];
    assert.equal(mentions.length, 1,
      'recovery must not use liveness to permit automatic lock removal');
    assert.equal(/classifyLockLiveness\([a-zA-Z]+,/.test(source), false,
      'a second argument was reintroduced to the liveness verdict');
    const live = { pid: process.pid, startedAt: new Date().toISOString() };
    assert.equal(classifyLockLiveness(live, { now: () => new Date(Date.now() + 4e10) }), 'live',
      'an injected clock changed the verdict');
  });

  it('refuses a lock held by a live process without modifying it', async () => {
    const context = await fixture();
    crash(context, 'destination-replaced');
    const store = createFormatV2Store({ env: context.env });
    const binding = await store.readProjectBinding(context.projectRoot);

    // Replace the dead crash lock with an authenticated lock minted by THIS
    // process, which is unambiguously alive.
    await fs.rm(store.lockPath(binding, 'baseline'), { force: true });
    const live = await store.acquireLock(binding, 'baseline');
    assert.equal(classifyLockLiveness(await store.inspectLock(binding, 'baseline')), 'live');

    const result = cli(context, ['recover']);
    assert.equal(result.status, 4, `expected a security refusal, got ${result.status}`);
    assert.match(result.stderr, /slot lock is present/);
    // The competitor's lock survives untouched.
    assert.notEqual(await store.inspectLock(binding, 'baseline'), null);
    await live.release();
  });

  it('fails closed on a malformed, unauthenticated, or foreign lock', async () => {
    for (const [name, mutate] of [
      ['malformed', async (file) => fs.writeFile(file, 'not json at all')],
      ['unauthenticated', async (file) => {
        const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
        parsed.pid = 999999;
        await fs.writeFile(file, JSON.stringify(parsed));
      }],
      ['foreign', async (file) => {
        const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
        parsed.ownerScope = 'somebody-else';
        await fs.writeFile(file, JSON.stringify(parsed));
      }],
    ]) {
      const context = await fixture();
      crash(context, 'destination-replaced');
      const store = createFormatV2Store({ env: context.env });
      const binding = await store.readProjectBinding(context.projectRoot);
      const lockFile = store.lockPath(binding, 'baseline');
      await mutate(lockFile);

      const result = cli(context, ['recover']);
      assert.equal(result.status, 4, `${name}: expected a security refusal, got ${result.status}`);
      assert.match(result.stderr, /lock/i, `${name}: refusal did not name the lock`);
      // The unusable lock is left exactly as found — never deleted, never repaired.
      assert.notEqual(await fs.readFile(lockFile, 'utf8').catch(() => null), null,
        `${name}: recovery removed a lock it could not authenticate`);
    }
  });

  it('leaves a competitor lock untouched after the owner clears a stale lock', async () => {
    const context = await fixture();
    crash(context, 'destination-replaced');
    const store = createFormatV2Store({ env: context.env });
    const binding = await store.readProjectBinding(context.projectRoot);
    const lockFile = store.lockPath(binding, 'baseline');

    const dead = await store.inspectLock(binding, 'baseline');
    assert.equal(classifyLockLiveness(dead), 'abandoned');

    // The owner clears the stale lock, then a competitor takes the slot.
    await fs.rm(lockFile, { force: true });
    const competitor = await store.acquireLock(binding, 'baseline');
    const held = await store.inspectLock(binding, 'baseline');
    assert.equal(classifyLockLiveness(held), 'live', 'the competitor lock must be live');
    assert.notEqual(held.transactionId, dead.transactionId);

    const result = cli(context, ['recover']);
    assert.equal(result.status, 4, `expected a security refusal, got ${result.status}`);
    // The competitor's lock survives byte-for-byte.
    const survived = await store.inspectLock(binding, 'baseline');
    assert.notEqual(survived, null, 'recovery deleted a live competitor lock');
    assert.equal(survived.transactionId, held.transactionId);
    assert.equal(survived.mac, held.mac);
    await competitor.release();
  });

  it('does not touch a lock belonging to a different transaction', async () => {
    const context = await fixture();
    crash(context, 'destination-replaced');
    const store = createFormatV2Store({ env: context.env });
    const binding = await store.readProjectBinding(context.projectRoot);

    // A valid, authenticated, ABANDONED lock — but for another transaction.
    await fs.rm(store.lockPath(binding, 'baseline'), { force: true });
    const other = await store.acquireLock(binding, 'baseline');
    const raw = JSON.parse(await fs.readFile(store.lockPath(binding, 'baseline'), 'utf8'));
    assert.notEqual(raw.transactionId, undefined);

    const result = cli(context, ['recover']);
    assert.equal(result.status, 4);
    assert.match(result.stderr, /slot lock is present/);
    await other.release();
  });

  it('does not expose recovery outside the restore CLI', async () => {
    // A public-surface guard local to this file, so a future change that makes
    // recovery reachable fails here as well as in the boundary suite.
    await assert.rejects(
      import('noosphere-continuity/continuity/internal/restore/recovery.js'),
      (error) => error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
    );
    const publicModule = await import('noosphere-continuity/trust-store');
    assert.equal('recoverRestoreTransactions' in publicModule, false);
  });
});
