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
      await entry.underlying.release();
      state.held.pop();
      entry.released = true;
    },
  });
}
