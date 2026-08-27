// Small, side-effect-free supervision primitives for the always-running
// manager. Keeping these outside manager.js makes the concurrency and child
// lifecycle rules directly testable without starting a daemon.

export function createCoalescedRunner(task, { onError } = {}) {
  if (typeof task !== 'function') throw new TypeError('coalesced runner requires a task');
  if (onError !== undefined && typeof onError !== 'function') {
    throw new TypeError('coalesced runner onError must be a function');
  }
  let active = null;
  let pending = false;
  let stopped = false;

  async function drain() {
    do {
      pending = false;
      try {
        await task();
      } catch (error) {
        if (!onError) throw error;
        await onError(error);
      }
    } while (pending && !stopped);
  }

  return Object.freeze({
    run() {
      if (stopped) return Promise.resolve();
      if (active) {
        pending = true;
        return active;
      }
      active = drain().finally(() => {
        active = null;
      });
      return active;
    },
    stop() {
      stopped = true;
      pending = false;
    },
  });
}

export function superviseChild(child, onDone) {
  if (!child || typeof child.once !== 'function') {
    throw new TypeError('child supervision requires an EventEmitter-like child');
  }
  if (typeof onDone !== 'function') throw new TypeError('child supervision requires onDone');
  let done = false;
  const finish = (outcome) => {
    if (done) return;
    done = true;
    onDone(Object.freeze(outcome));
  };
  child.once('error', (error) => finish({ code: null, signal: null, error }));
  child.once('exit', (code, signal) => finish({ code, signal, error: null }));
}
