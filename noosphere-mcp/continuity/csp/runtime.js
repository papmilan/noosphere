import { observeRepository as observeGitRepository } from '../acp/git-state.js';
import { loadStateRecord, updateRuntimeState } from './storage.js';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export async function recordRuntimeObservation(root, options = {}) {
  const observeRepository = options.observeRepository ?? observeGitRepository;
  const [observed, stateRecord] = await Promise.all([
    observeRepository(root),
    loadStateRecord(root),
  ]);
  const agent = detectAgent(options);
  const observedAt = currentClock(options.clock);
  const written = await updateRuntimeState(root, (runtime) => {
    const previous = isPlainObject(runtime.csp) ? runtime.csp : {};
    const stateIdentity = stateRecord?.identity ?? null;
    const previousRevision = Number.isInteger(previous.revision) && previous.revision >= 0
      ? previous.revision
      : 0;
    const revision = stateIdentity === null
      ? 0
      : (previous.state_identity === stateIdentity ? previousRevision : previousRevision + 1);
    return {
      ...runtime,
      csp: {
        ...previous,
        revision,
        state_identity: stateIdentity,
        observed_branch: boundedNullable(observed.branch, 255),
        observed_head: validHead(observed.head),
        agent,
        observed_at: observedAt,
        last_transition_at: options.transition === true
          ? observedAt
          : (previous.last_transition_at ?? null),
      },
    };
  });
  return written.state.csp;
}

export function detectAgent(options = {}) {
  if (options.agent !== undefined) return validateAgent(options.agent);
  const env = options.env ?? process.env;
  return validateAgent({
    vendor: env.NOOSPHERE_AGENT_VENDOR || env.NOOSPHERE_PROVIDER || 'unknown',
    name: env.NOOSPHERE_AGENT_NAME || env.NOOSPHERE_AGENT_ID || env.NOOSPHERE_CLIENT || 'unknown',
    version: env.NOOSPHERE_AGENT_VERSION || null,
  });
}

function validateAgent(value) {
  if (!isPlainObject(value)) throw runtimeError('agent must be an object');
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'name,vendor,version') {
    throw runtimeError('agent must contain exactly vendor, name, and version');
  }
  return {
    vendor: boundedString(value.vendor, 100, 'agent.vendor'),
    name: boundedString(value.name, 100, 'agent.name'),
    version: value.version === null ? null : boundedString(value.version, 100, 'agent.version'),
  };
}

function boundedNullable(value, maxLength) {
  return value === null || value === undefined ? null : boundedString(value, maxLength, 'observed branch');
}

function boundedString(value, maxLength, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw runtimeError(`${label} must contain 1-${maxLength} characters`);
  }
  if (CONTROL_CHARACTERS.test(value) || value !== value.normalize('NFC')) {
    throw runtimeError(`${label} must be NFC text without control characters`);
  }
  return value;
}

function validHead(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !GIT_OBJECT_ID.test(value)) {
    throw runtimeError('observed HEAD must be a lowercase 40/64 character Git object ID');
  }
  return value;
}

function currentClock(clock) {
  const value = typeof clock === 'function' ? clock() : (clock ?? new Date().toISOString());
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || !value.endsWith('Z')) {
    throw runtimeError('runtime observation time must be a UTC ISO-8601 timestamp');
  }
  return value;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function runtimeError(message) {
  return Object.assign(new Error(message), { code: 'csp-runtime-observation-invalid' });
}
