import {
  acquireReplayIdentityLock,
  acquireReplayProjectLock,
} from './lock.js';
import { createRankedLockScope } from './lock-ranks.js';
import {
  listReplayJournals,
  recoverReplayJournal,
} from './journal.js';
import {
  ensureReplayProject,
  markReplayRecovery,
} from './store.js';

export async function withReplayOperation({
  env = process.env,
  projectIdentityDigest,
  replayIdentity,
}, callback) {
  if (typeof callback !== 'function') {
    throw new TypeError('replay operation callback is required');
  }
  const { key, paths } = await ensureReplayProject({
    env,
    projectIdentityDigest,
  });
  const scope = createRankedLockScope();
  const projectLock = await acquireReplayProjectLock({
    scope,
    env,
    key,
    projectIdentityDigest,
  });
  const identityLocks = [];
  try {
    const journals = await listReplayJournals({
      env,
      key,
      projectIdentityDigest,
    });
    const identities = [...new Set([
      replayIdentity,
      ...journals
        .filter(chain => !chain.complete)
        .map(chain => chain.latest.replayIdentity),
    ])].sort();
    for (const identity of identities) {
      identityLocks.push(await acquireReplayIdentityLock({
        scope,
        env,
        key,
        projectIdentityDigest,
        replayIdentity: identity,
      }));
    }
    let recovered = false;
    for (const chain of journals.filter(item => !item.complete)) {
      recovered = await recoverReplayJournal({
        env,
        key,
        projectIdentityDigest,
        chain,
        scope,
      }) || recovered;
    }
    if (recovered) {
      await markReplayRecovery({
        env,
        key,
        projectIdentityDigest,
      });
    }
    return await callback(Object.freeze({ env, key, paths, scope }));
  } finally {
    for (const lock of identityLocks.reverse()) await lock.release();
    await projectLock.release();
  }
}
