import {
  acquireReplayIdentityLock,
  acquireReplayProjectLock,
} from './lock.js';
import {
  createRankedLockScope,
  releaseHeldLocks,
} from './lock-ranks.js';
import {
  listReplayJournals,
  recoverReplayJournal,
} from './journal.js';
import {
  ensureReplayProject,
  markReplayRecovery,
} from './store.js';
import {
  applyReplayRetention,
  listRetentionJournals,
  planReplayRetention,
  recoverRetentionJournal,
} from './retention.js';

export async function withReplayOperation({
  env = process.env,
  projectIdentityDigest,
  replayIdentity,
  observedAt,
  onStep,
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
  let operationFailure;
  try {
    const journals = await listReplayJournals({
      env,
      key,
      projectIdentityDigest,
    });
    const retentionPlan = await planReplayRetention({
      env,
      key,
      projectIdentityDigest,
      replayIdentity,
      now: observedAt,
    });
    const retentionJournals = await listRetentionJournals({
      env,
      key,
      projectIdentityDigest,
    });
    const identities = [...new Set([
      replayIdentity,
      ...journals
        .filter(chain => !chain.complete)
        .map(chain => chain.latest.replayIdentity),
      ...retentionPlan.evictions.map(item => item.record.replayIdentity),
      ...retentionJournals
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
    for (const chain of retentionJournals.filter(item => !item.complete)) {
      recovered = await recoverRetentionJournal({
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
    await applyReplayRetention({
      env,
      key,
      projectIdentityDigest,
      replayIdentity,
      scope,
      now: observedAt,
      onStep,
    });
    return await callback(Object.freeze({ env, key, paths, scope }));
  } catch (error) {
    operationFailure = error;
    throw error;
  } finally {
    await releaseHeldLocks(
      [...identityLocks].reverse().concat(projectLock),
      operationFailure,
    );
  }
}
