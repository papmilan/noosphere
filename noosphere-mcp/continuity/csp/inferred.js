import { createHash } from 'node:crypto';
import path from 'node:path';

import { atomicOwnerOnlyWrite, readBoundedRegularFile } from '../secure-fs.js';
import { readExactConfirmation } from '../internal/exact-confirmation.js';
import { ensureRuntimeStateIgnored, withCspLock } from './storage.js';
import { transitionState } from './transitions.js';
import { CSP_STATUSES, validateState } from './validate.js';

// Item 6 of docs/design/specs/2026-08-12-inferred-continuity.md, respecified
// there as provenance rather than a confidence float: a float is uncalibrated
// and unenforceable, and a wrong current_task at 0.6 still anchors the next
// agent that loads context. Provenance is checkable and can gate promotion.
//
// The gate is the file boundary, not a field. Tracked CSP state.json holds
// owner-authored values and nothing else; this file holds guesses and can only
// ever say `inferred`. There is no value of `source` that turns a record here
// into a canonical one, so promotion cannot be a bit flip — it is a copy across
// the boundary that an owner confirms, replayed through the ordinary transition
// path so every CSP invariant still applies.
//
// `owner` is therefore a label the read path derives for state.json's values,
// never a value anything writes here.
const INFERRED = 'inferred-state.json';
const SCHEMA = 'noosphere.inferred-state';
const VERSION = 1;
const MAX_INFERRED_BYTES = 64 * 1024;
const MAX_CONFIRMATION_BYTES = 256;

// Also the CLI's field map source: `continuity/index.js` runs its command
// switch during the entry-point await, before its own module-level consts leave
// the temporal dead zone, so the mapping cannot live there at module scope.
export const INFERRED_CLI_FIELDS = Object.freeze({
  status: 'status',
  'current-task': 'current_task',
  'next-action': 'next_action',
  blocker: 'blocker',
});

export const INFERRABLE_FIELDS = Object.freeze([
  'status',
  'current_task',
  'next_action',
  'blocker',
]);

// A field is inferred or it is absent. There is no inferred null: "I have no
// guess" is the absence of an entry, and letting a guess mean "clear this" would
// give the untrusted lane a way to erase owner-authored state.
const PROBE = Object.freeze({
  version: 1,
  status: 'in-progress',
  current_task: null,
  next_action: null,
  blocker: null,
});

export function inferredStatePath(root) {
  return path.join(root, '.noosphere', INFERRED);
}

export async function readInferredState(root) {
  const raw = await readBoundedRegularFile(inferredStatePath(root), {
    maxBytes: MAX_INFERRED_BYTES,
  }).catch(() => null);
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    if (parsed?.schema !== SCHEMA || !isPlainObject(parsed.fields)) return {};
    const fields = {};
    for (const field of INFERRABLE_FIELDS) {
      const entry = parsed.fields[field];
      if (!isPlainObject(entry)) continue;
      // Re-validated on read, not trusted from disk: this file is not
      // authenticated, and a value that could never be promoted must not be
      // displayed as though it could.
      if (!validInferredValue(field, entry.value)) continue;
      fields[field] = {
        value: entry.value,
        source: 'inferred',
        basis: typeof entry.basis === 'string' ? entry.basis : '',
        observed_at: typeof entry.observed_at === 'string' ? entry.observed_at : '',
      };
    }
    return fields;
  } catch {
    // Corrupt telemetry must never fail a read that only wanted to know whether
    // a guess exists. It is rebuilt by the next writer.
    return {};
  }
}

/**
 * Records one inferred field. Rejects a value CSP itself would reject, so the
 * lane cannot accumulate guesses that could never be promoted.
 */
export async function recordInferredField(root, field, value, { basis, now } = {}) {
  if (!INFERRABLE_FIELDS.includes(field)) {
    throw inferredError('inferred-field-unknown', `${field} is not an inferable CSP v1 field`);
  }
  if (!validInferredValue(field, value)) {
    throw inferredError(
      'inferred-value-invalid',
      `${field} value is not valid CSP v1 content`,
    );
  }
  // A guess with no stated basis cannot be reviewed at promotion time, which is
  // the only moment it matters.
  if (!validInferredValue('current_task', basis)) {
    throw inferredError('inferred-basis-required', 'a basis is required and must be valid CSP v1 content');
  }
  // The write that creates the file is what guarantees it stays out of git:
  // recording a guess is reachable without any other CSP command having run, so
  // waiting for one to refresh the local exclude would leave the first guess
  // showing up as an untracked file in the developer's working tree.
  await ensureRuntimeStateIgnored(root);
  return withCspLock(root, async () => {
    const fields = await readInferredState(root);
    fields[field] = { value, source: 'inferred', basis, observed_at: now };
    await writeInferredFields(root, fields);
    return fields[field];
  });
}

export async function clearInferredFields(root, fields = INFERRABLE_FIELDS) {
  return withCspLock(root, async () => {
    const current = await readInferredState(root);
    const removed = [];
    for (const field of fields) {
      if (Object.hasOwn(current, field)) {
        delete current[field];
        removed.push(field);
      }
    }
    if (removed.length > 0) await writeInferredFields(root, current);
    return removed;
  });
}

// Order-independent, so the phrase depends on which values are being promoted
// and not on the order they happen to sit in the file.
export function inferredDigest(changes) {
  const canonical = Object.keys(changes)
    .sort()
    .map((field) => `${field}=${changes[field]}`)
    .join('\n');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function promotionPhrase(rawHash) {
  return `promote state ${rawHash.slice(0, 8)}`;
}

/**
 * Copies inferred values into tracked CSP after the owner confirms them, then
 * drops them from the inferred lane. The write itself goes through
 * transitionState, so status edges, the blocked-needs-a-blocker rule, and
 * concurrent-write detection all still hold — promotion adds a source of
 * proposals, never a way around the machine.
 */
export async function promoteInferredFields({
  root,
  fields,
  confirm,
  input = process.stdin,
  output = process.stdout,
} = {}) {
  const inferred = await readInferredState(root);
  const selected = (fields ?? Object.keys(inferred)).filter((field) => Object.hasOwn(inferred, field));
  if (selected.length === 0) {
    throw inferredError('inferred-nothing-to-promote', 'There is no inferred value to promote.');
  }
  const changes = Object.fromEntries(selected.map((field) => [field, inferred[field].value]));
  const rawHash = inferredDigest(changes);
  const approved = await (confirm ?? ttyConfirm)({
    entries: selected.map((field) => ({ field, ...inferred[field] })),
    changes,
    rawHash,
    phrase: promotionPhrase(rawHash),
    input,
    output,
  });
  if (approved !== true) {
    throw inferredError('inferred-promotion-declined', 'Promotion was not confirmed; nothing was changed.');
  }
  const result = await transitionState(root, { type: 'set', changes });
  // Only clear what the owner approved, and only once it is durable: a failed
  // transition must leave the guess where it was rather than silently losing it.
  if (result.ok) await clearInferredFields(root, selected);
  return { ...result, promoted: selected, rawHash };
}

// Interactive only, like `trust approve` and `journal confirm`: an agent may
// write a guess into this lane, but the transition into owner-authored state is
// the owner's act. There is no --yes.
async function ttyConfirm({ entries, rawHash, phrase, input, output }) {
  output.write([
    '',
    'These inferred values would become tracked CSP state, authored by you:',
    '',
    ...entries.flatMap((entry) => [
      `  ${entry.field}: ${entry.value}`,
      `    basis:    ${entry.basis || '(none recorded)'}`,
      `    observed: ${entry.observed_at || '(unknown)'}`,
    ]),
    '',
    `sha256: ${rawHash}`,
    '',
    `Type "${phrase}" to promote them, anything else to abort.`,
    '',
  ].join('\n'));
  return readExactConfirmation({
    input,
    output,
    phrase,
    maxBytes: MAX_CONFIRMATION_BYTES,
    ttyCode: 'promotion-requires-tty',
    ttyMessage:
      'promoting inferred state requires an interactive terminal; run this yourself, in your own shell',
    tooLongCode: 'promotion-input-too-long',
    tooLongMessage: `confirmation exceeds the ${MAX_CONFIRMATION_BYTES}-byte limit`,
  });
}

async function writeInferredFields(root, fields) {
  const body = `${JSON.stringify({ schema: SCHEMA, version: VERSION, fields }, null, 2)}\n`;
  await atomicOwnerOnlyWrite(inferredStatePath(root), body, { root });
}

// Validated by proposing the value to the real CSP validator rather than by a
// second copy of its rules: length, control characters, NFC and the status enum
// are then guaranteed to agree with what promotion will later enforce.
function validInferredValue(field, value) {
  if (typeof value !== 'string') return false;
  // status is checked against the enum alone: `blocked` is a legitimate guess,
  // and whether it may be adopted depends on the blocker and the current status,
  // which is transitionState's decision at promotion time, not this lane's.
  if (field === 'status') return CSP_STATUSES.includes(value);
  return validateState({ ...PROBE, [field]: value }).ok;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function inferredError(code, message) {
  return Object.assign(new Error(message), { code });
}
