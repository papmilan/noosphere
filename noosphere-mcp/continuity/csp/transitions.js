import { isDeepStrictEqual } from 'node:util';

import { mergeState } from './merge.js';
import { recordRuntimeObservation } from './runtime.js';
import {
  loadStateRecord,
  readStateRecord,
  ensureTrackedStateVisible,
  withCspLock,
  writeStateAtomic,
} from './storage.js';
import { validateState } from './validate.js';

const CONTENT_FIELDS = new Set(['status', 'current_task', 'next_action', 'blocker']);
const GENERIC_EDGES = {
  'not-started': new Set(['not-started', 'in-progress', 'archived']),
  'in-progress': new Set(['in-progress', 'blocked', 'done', 'archived']),
  blocked: new Set(['blocked', 'in-progress', 'done', 'archived']),
  done: new Set(['done']),
  archived: new Set(['archived']),
};

export async function transitionState(root, transition, options = {}) {
  await ensureTrackedStateVisible(root);
  const baseRecord = await loadStateRecord(root);
  const baseState = baseRecord?.state ?? initialState();
  const proposed = applyTransition(baseState, transition);

  await options.beforeCommit?.();

  const maxRetries = options.maxRetries ?? 8;
  let committed;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      const result = await withCspLock(root, async () => {
        const currentRecord = await readStateRecord(root);
        const currentState = currentRecord?.state ?? initialState();
        const fileChanged = (currentRecord?.identity ?? null) !== (baseRecord?.identity ?? null);

        let candidate = proposed;
        if (fileChanged) {
          const merged = mergeState(baseState, currentState, proposed);
          if (!merged.ok) {
            return { ok: false, conflicts: merged.conflicts, state: currentState };
          }
          candidate = merged.state;
        }
        const finalState = { ...candidate, version: 1 };
        const validated = validateState(finalState);
        if (!validated.ok) {
          throw transitionError('csp-transition-invalid', `Transition produced invalid CSP state: ${validated.errors
            .map((entry) => `${entry.path}: ${entry.message}`)
            .join('; ')}`, {
            errors: validated.errors,
          });
        }
        if (currentRecord !== null && isDeepStrictEqual(validated.state, currentState)) {
          return {
            ok: true,
            state: currentState,
            identity: currentRecord.identity,
            conflicts: [],
            changed: false,
          };
        }
        const written = await writeStateAtomic(
          root,
          validated.state,
          currentRecord?.identity ?? null,
        );
        return { ok: true, ...written, conflicts: [], changed: true };
      });
      if (!result.ok) return result;
      committed = result;
      break;
    } catch (error) {
      if (error.code === 'csp-write-stale') continue;
      throw error;
    }
  }
  if (committed === undefined) {
    throw transitionError('csp-transition-retry-exhausted', 'CSP changed repeatedly during transition');
  }
  try {
    const runtime = await recordRuntimeObservation(root, {
      ...options,
      transition: committed.changed,
    });
    return { ...committed, runtime, runtime_error: null };
  } catch (error) {
    return {
      ...committed,
      runtime: null,
      runtime_error: { code: error.code || 'csp-runtime-observation-failed', message: error.message },
    };
  }
}

export function applyTransition(state, transition) {
  if (transition === null || typeof transition !== 'object' || Array.isArray(transition)) {
    throw transitionError('csp-transition-invalid', 'Transition must be an object');
  }
  const next = structuredClone(state);
  switch (transition.type) {
    case 'reopen':
      assertNoChanges(transition);
      if (state.status !== 'done') {
        throw transitionError('csp-transition-invalid', 'reopen requires status done');
      }
      next.status = 'in-progress';
      break;
    case 'restore':
      assertNoChanges(transition);
      if (state.status !== 'archived') {
        throw transitionError('csp-transition-invalid', 'restore requires status archived');
      }
      next.status = 'in-progress';
      break;
    case 'set':
      applyChanges(state, next, transition.changes);
      break;
    default:
      throw transitionError('csp-transition-invalid', `Unknown transition type: ${transition.type}`);
  }

  if (next.status === 'blocked' && next.blocker === null) {
    throw transitionError('csp-transition-invalid', 'blocked status requires a non-null blocker');
  }
  return next;
}

function applyChanges(previous, next, changes) {
  if (changes === null || typeof changes !== 'object' || Array.isArray(changes)) {
    throw transitionError('csp-transition-invalid', 'set transition requires a changes object');
  }
  for (const field of Object.keys(changes)) {
    if (!CONTENT_FIELDS.has(field)) {
      throw transitionError('csp-transition-field', `${field} is not mutable in CSP v1`);
    }
  }
  if (Object.hasOwn(changes, 'status')) {
    const requested = changes.status;
    if ((previous.status === 'done' || previous.status === 'archived')
      && requested !== previous.status) {
      throw transitionError(
        'csp-terminal-intent-required',
        `${previous.status} requires an explicit ${previous.status === 'done' ? 'reopen' : 'restore'} transition`,
      );
    }
    if (!GENERIC_EDGES[previous.status]?.has(requested)) {
      throw transitionError(
        'csp-transition-invalid',
        `status transition ${previous.status} -> ${requested} is not allowed`,
      );
    }
  }
  Object.assign(next, structuredClone(changes));
}

function assertNoChanges(transition) {
  const extras = Object.keys(transition).filter((key) => key !== 'type');
  if (extras.length > 0) {
    throw transitionError('csp-transition-invalid', `${transition.type} does not accept changes`);
  }
}

function initialState() {
  return {
    version: 1,
    status: 'not-started',
    current_task: null,
    next_action: null,
    blocker: null,
  };
}

function transitionError(code, message, details = {}) {
  return Object.assign(new Error(message), { code }, details);
}
