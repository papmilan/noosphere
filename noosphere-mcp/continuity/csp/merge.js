import { isDeepStrictEqual } from 'node:util';

export function mergeState(base, current, proposed) {
  const conflicts = [];
  const merged = mergeObject(
    descriptor(base),
    descriptor(current),
    descriptor(proposed),
    '$',
    conflicts,
  );
  conflicts.sort((left, right) => left.path.localeCompare(right.path));
  if (conflicts.length > 0) return { ok: false, conflicts };
  return { ok: true, state: merged.value, conflicts: [] };
}

function mergeNode(base, current, proposed, path, conflicts) {
  if (same(current, proposed)) return cloneDescriptor(current);
  if (same(current, base)) return cloneDescriptor(proposed);
  if (same(proposed, base)) return cloneDescriptor(current);

  const valuesAreObjects = [base, current, proposed]
    .every((entry) => !entry.present || isPlainObject(entry.value));
  if (valuesAreObjects && current.present && proposed.present) {
    return mergeObject(base, current, proposed, path, conflicts, false);
  }

  conflicts.push({
    path,
    base: conflictValue(base),
    current: conflictValue(current),
    proposed: conflictValue(proposed),
  });
  return cloneDescriptor(current);
}

function mergeObject(base, current, proposed, path, conflicts) {
  const baseValue = base.present ? base.value : {};
  const currentValue = current.present ? current.value : {};
  const proposedValue = proposed.present ? proposed.value : {};
  const result = {};
  const keys = new Set([
    ...Object.keys(baseValue),
    ...Object.keys(currentValue),
    ...Object.keys(proposedValue),
  ]);

  for (const key of [...keys].sort()) {
    const baseChild = propertyDescriptor(baseValue, key);
    const currentChild = propertyDescriptor(currentValue, key);
    const proposedChild = propertyDescriptor(proposedValue, key);
    const child = mergeNode(baseChild, currentChild, proposedChild, `${path}.${key}`, conflicts);
    if (child.present) defineSafe(result, key, child.value);
  }
  return descriptor(result);
}

function propertyDescriptor(object, key) {
  return Object.hasOwn(object, key)
    ? descriptor(object[key])
    : { present: false };
}

function descriptor(value) {
  return { present: true, value };
}

function cloneDescriptor(entry) {
  return entry.present
    ? descriptor(structuredClone(entry.value))
    : { present: false };
}

function same(left, right) {
  return left.present === right.present
    && (!left.present || isDeepStrictEqual(left.value, right.value));
}

function conflictValue(entry) {
  return entry.present ? structuredClone(entry.value) : { missing: true };
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function defineSafe(target, key, value) {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
}
