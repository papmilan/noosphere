const TOP_LEVEL_FIELDS = [
  'version',
  'status',
  'current_task',
  'next_action',
  'blocker',
];

const STATUSES = new Set(['not-started', 'in-progress', 'blocked', 'done', 'archived']);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

export function validateState(input) {
  const errors = [];
  if (!isPlainObject(input)) {
    return invalid('$', 'type', 'state must be an object');
  }

  validateRequiredAndUnknown(input, TOP_LEVEL_FIELDS, '$', errors);
  if ('version' in input && input.version !== 1) {
    errors.push(issue('$.version', 'unsupported-version', 'version must be 1'));
  }
  if ('status' in input && (typeof input.status !== 'string' || !STATUSES.has(input.status))) {
    errors.push(issue('$.status', 'enum', 'status is not a CSP v1 status'));
  }

  validateNullableString(input.current_task, '$.current_task', 1000, errors);
  validateNullableString(input.next_action, '$.next_action', 1000, errors);
  validateNullableString(input.blocker, '$.blocker', 1000, errors);
  if (input.status === 'blocked' && input.blocker === null) {
    errors.push(issue('$.blocker', 'blocked-without-blocker', 'blocked state requires a blocker'));
  }

  if (errors.length > 0) return { ok: false, errors };
  const state = structuredClone(input);
  deepFreeze(state);
  return { ok: true, state, errors: [] };
}

function validateRequiredAndUnknown(value, fields, basePath, errors) {
  const allowed = new Set(fields);
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) {
      errors.push(issue(`${basePath}.${field}`, 'required', `${field} is required`));
    }
  }
  for (const field of Object.keys(value).sort()) {
    if (!allowed.has(field)) {
      errors.push(issue(`${basePath}.${field}`, 'unknown-field', `${field} is not part of CSP v1`));
    }
  }
}

function validateNullableString(value, path, maxLength, errors) {
  if (value === null) return;
  validateString(value, path, maxLength, errors);
}

function validateString(value, path, maxLength, errors) {
  if (typeof value !== 'string') {
    errors.push(issue(path, 'type', `${path} must be a string`));
    return;
  }
  const length = Array.from(value).length;
  if (length === 0 || length > maxLength) {
    errors.push(issue(path, 'string-length', `${path} must contain 1-${maxLength} characters`));
  }
  if (CONTROL_CHARACTERS.test(value)) {
    errors.push(issue(path, 'control-character', `${path} contains a control character`));
  }
  if (value !== value.normalize('NFC')) {
    errors.push(issue(path, 'not-nfc', `${path} must be NFC-normalized`));
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function invalid(path, code, message) {
  return { ok: false, errors: [issue(path, code, message)] };
}

function issue(path, code, message) {
  return { path, code, message };
}

export const CSP_STATUSES = Object.freeze([...STATUSES]);
