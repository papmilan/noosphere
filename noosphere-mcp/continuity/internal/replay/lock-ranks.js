export const LOCK_RANKS = Object.freeze({
  replayCatalog: 10,
  replayProject: 20,
  replayIdentity: 30,
  restoreCandidateIndex: 40,
  restoreCandidateState: 50,
  authorityTransaction: 60,
});

const VALID_RANKS = new Set(Object.values(LOCK_RANKS));
const SCOPES = new WeakMap();

function lockOrderError(code, message) {
  const error = new Error(message);
  error.name = 'LockOrderError';
  error.code = code;
  return error;
}

function scopeState(scope) {
  const state = SCOPES.get(scope);
  if (!state) {
    throw lockOrderError(
      'lock-scope-invalid',
      'ranked lock scope is invalid',
    );
  }
  return state;
}

export function createRankedLockScope() {
  const scope = Object.freeze({});
  SCOPES.set(scope, {
    acquiring: false,
    held: [],
  });
  return scope;
}

export function assertReplayMutationScope(
  scope,
  { projectIdentityDigest, replayIdentity },
) {
  const state = scopeState(scope);
  const expected = [
    {
      rank: LOCK_RANKS.replayProject,
      key: `replay-project:${projectIdentityDigest}`,
    },
    {
      rank: LOCK_RANKS.replayIdentity,
      key: `replay-identity:${projectIdentityDigest}:${replayIdentity}`,
    },
  ];
  if (
    state.held.length < expected.length ||
    state.held[0].rank !== expected[0].rank ||
    state.held[0].key !== expected[0].key ||
    !state.held.some(held =>
      held.rank === expected[1].rank && held.key === expected[1].key)
  ) {
    throw lockOrderError(
      'replay-mutation-scope-invalid',
      'replay mutation requires its ranked project and identity locks',
    );
  }
}

function assertAcquisitionOrder(state, rank, key) {
  if (!VALID_RANKS.has(rank) || typeof key !== 'string' || key.length === 0) {
    throw lockOrderError(
      'lock-rank-input-invalid',
      'lock rank and canonical key are invalid',
    );
  }
  if (rank === LOCK_RANKS.authorityTransaction && state.held.length > 0) {
    throw lockOrderError(
      'lock-rank-authority-boundary',
      'authority/apply locking requires an empty replay-restore lock scope',
    );
  }
  const prior = state.held.at(-1);
  if (
    prior &&
    (rank < prior.rank || (rank === prior.rank && key <= prior.key))
  ) {
    throw lockOrderError(
      'lock-rank-order-invalid',
      'locks must be acquired by ascending rank and lexical peer key',
    );
  }
}

// Release locks in the order given, refusals included. A lock whose file was
// removed or tampered with is owner-intervention territory by design; the
// healthy locks under it are not, and stopping at the first refusal turns one
// artifact the owner must clear into the whole stack. The first refusal is
// still reported — but never in place of `operationFailure`, because a release
// error thrown out of a `finally` replaces the error that explains what
// actually went wrong.
export async function releaseHeldLocks(locks, operationFailure) {
  let releaseFailure;
  for (const lock of locks) {
    try { await lock.release(); }
    catch (error) { releaseFailure ??= error; }
  }
  if (releaseFailure && !operationFailure) throw releaseFailure;
}

export async function acquireRankedLock(scope, {
  rank,
  key,
  acquire,
}) {
  const state = scopeState(scope);
  if (state.acquiring) {
    throw lockOrderError(
      'lock-scope-acquisition-pending',
      'ranked lock scope already has an acquisition in progress',
    );
  }
  if (typeof acquire !== 'function') {
    throw lockOrderError(
      'lock-rank-input-invalid',
      'ranked lock acquisition callback is invalid',
    );
  }
  assertAcquisitionOrder(state, rank, key);
  state.acquiring = true;
  let underlying;
  try {
    underlying = await acquire();
  } finally {
    state.acquiring = false;
  }
  if (!underlying || typeof underlying.release !== 'function') {
    throw lockOrderError(
      'lock-handle-invalid',
      'lock acquisition did not return a releasable handle',
    );
  }

  const entry = {
    key,
    rank,
    released: false,
    underlying,
  };
  state.held.push(entry);
  return Object.freeze({
    key,
    rank,
    async release() {
      if (entry.released) return;
      if (state.held.at(-1) !== entry) {
        throw lockOrderError(
          'lock-release-order-invalid',
          'locks must be released in reverse acquisition order',
        );
      }
      // The held stack tracks acquisition order, not what is on disk. When the
      // underlying release refuses — a lock file removed or tampered with
      // underneath us — the error still propagates, but the entry comes off the
      // stack so the locks below it can still be released. Leaving it there made
      // every one of them answer lock-release-order-invalid from then on, so a
      // single refusal stranded the whole scope rather than one artifact, and no
      // retry could unwind it.
      try {
        await entry.underlying.release();
      } finally {
        state.held.pop();
        entry.released = true;
      }
    },
  });
}
