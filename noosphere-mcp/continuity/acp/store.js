import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createProjectState } from './project-state.js';
import { decodeEnvelope, encodeEnvelope } from './wire.js';
import { classifyCompatibility, observeRepository } from './git-state.js';
import { renderKernel } from './render.js';

const JSON_FILE = 'continuity.json';
const MD_FILE = 'continuity.md';

export function statePaths(root) {
  const dir = path.join(root, '.noosphere');
  return { dir, json: path.join(dir, JSON_FILE), markdown: path.join(dir, MD_FILE) };
}

// Reads the persisted canonical envelope. Returns null if none exists yet, or
// the decode result ({ ok, state | errors }) otherwise.
export async function readState(root, options = {}) {
  const { json } = statePaths(root);
  let raw;
  try {
    raw = await readFile(json, 'utf8');
  } catch {
    return null;
  }
  return decodeEnvelope(raw, { clock: options.clock ?? nowIso(), policy: options.policy });
}

// Builds an initial state from observable Git facts only. It does not infer a
// goal; the objective is left explicitly unspecified for a human or agent.
export async function buildInitialState(root, options = {}) {
  const clock = options.clock ?? nowIso();
  const observed = await observeRepository(root);
  const envelope = initialEnvelope(root, observed, options.projectId, clock);
  const signed = encodeEnvelope({ envelope });
  return decodeEnvelope(signed, { clock, policy: options.policy });
}

// Atomically persists canonical JSON, then the derived Markdown kernel. On any
// failure before the renames, the existing files are left untouched.
export async function writeState(root, state, options = {}) {
  const { dir, json, markdown } = statePaths(root);
  await mkdir(dir, { recursive: true });
  const envelope = encodeEnvelope(state);
  const compatibility = options.compatibility
    ?? classifyCompatibility(state, await observeRepository(root));
  const kernel = renderKernel(state, { compatibility, snapshotId: envelope.snapshot_id });
  const jsonTmp = `${json}.${process.pid}.tmp`;
  const mdTmp = `${markdown}.${process.pid}.tmp`;
  try {
    await writeFile(jsonTmp, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
    await writeFile(mdTmp, `${kernel}\n`, { mode: 0o600 });
    await rename(jsonTmp, json);
    await rename(mdTmp, markdown);
  } finally {
    await rm(jsonTmp, { force: true }).catch(() => {});
    await rm(mdTmp, { force: true }).catch(() => {});
  }
  return { envelope, kernel, compatibility };
}

export async function writeStateIfCurrent(root, state, expectedSnapshotId, options = {}) {
  if (expectedSnapshotId !== null && !/^sha256:[0-9a-f]{64}$/.test(expectedSnapshotId)) {
    throw storeError('invalid-expected-snapshot-id');
  }
  const { dir, json, markdown } = statePaths(root);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const envelope = encodeEnvelope(state);
  const compatibility = options.compatibility
    ?? classifyCompatibility(state, await observeRepository(root));
  const kernel = renderKernel(state, { compatibility, snapshotId: envelope.snapshot_id });
  const token = randomUUID();
  const jsonTmp = `${json}.${token}.tmp`;
  const mdTmp = `${markdown}.${token}.tmp`;
  const previousJson = await readOptional(json);
  const previousMarkdown = await readOptional(markdown);
  let jsonRenamed = false;
  const renameForCommit = options.rename ?? rename;
  try {
    await writeFile(jsonTmp, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await writeFile(mdTmp, `${kernel}\n`, { mode: 0o600, flag: 'wx' });
    const currentId = await currentSnapshotId(json, options);
    if (currentId !== expectedSnapshotId) throw storeError('confirmation-stale');
    await renameForCommit(jsonTmp, json);
    jsonRenamed = true;
    await renameForCommit(mdTmp, markdown);
  } catch (error) {
    if (jsonRenamed) {
      try {
        await restorePair(json, markdown, previousJson, previousMarkdown);
      } catch (rollbackError) {
        throw storeError('state-rollback-failed', new AggregateError([error, rollbackError]));
      }
    }
    throw error;
  } finally {
    await rm(jsonTmp, { force: true }).catch(() => undefined);
    await rm(mdTmp, { force: true }).catch(() => undefined);
  }
  return { envelope, kernel, compatibility };
}

// Validates the persisted pair: the envelope must decode (digest + schema), the
// Markdown must match a fresh render, and the repository must not be foreign.
export async function validateState(root, options = {}) {
  const clock = options.clock ?? nowIso();
  const { json, markdown } = statePaths(root);
  let raw;
  try {
    raw = await readFile(json, 'utf8');
  } catch {
    return { ok: false, errors: [{ path: '$', code: 'missing-state', message: 'no continuity.json to validate' }] };
  }
  const decoded = decodeEnvelope(raw, { clock, policy: options.policy });
  if (!decoded.ok) return { ok: false, errors: decoded.errors };

  const observed = await observeRepository(root);
  const compatibility = classifyCompatibility(decoded.state, observed);
  const expected = renderKernel(decoded.state, { compatibility, snapshotId: decoded.state.envelope.snapshot_id });
  const actual = (await readFile(markdown, 'utf8').catch(() => '')).replace(/\n$/, '');
  const errors = [];
  if (compatibility.status === 'foreign') {
    errors.push({ path: '$.repository', code: 'foreign', message: 'persisted state belongs to a different repository' });
  }
  if (actual !== expected) {
    errors.push({ path: '$', code: 'kernel-mismatch', message: 'continuity.md does not match the canonical envelope' });
  }
  return { ok: errors.length === 0, errors, state: decoded.state, compatibility };
}

function initialEnvelope(root, observed, projectId, clock) {
  const id = projectId || path.basename(root) || 'project';
  return {
    protocol: 'acp.project-state-envelope',
    schema_version: '1.0.0',
    snapshot_id: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    parent_snapshot_id: null,
    created_at: clock,
    expires_at: null,
    origin: { agent_id: 'noosphere-cli', client: 'noosphere-continuity', session_id: null },
    integrity: {
      algorithm: 'sha256',
      digest: '0000000000000000000000000000000000000000000000000000000000000000',
      signature: { status: 'unsigned', algorithm: null, key_id: null, value: null },
    },
    permission_scope: 'project',
    trust: { level: 'local-unverified', reasons: ['generated from local Git observation'] },
    repository: {
      project_id: id,
      root_identity: observed.root_identity ?? `sha256:${createHash('sha256').update(path.resolve(root)).digest('hex')}`,
      head: observed.head,
      branch: observed.branch,
      merge_base: null,
      dirty: observed.dirty,
      workspace_fingerprint: observed.workspace_fingerprint,
    },
    phase: 'discovery',
    goal: {
      project: id,
      current_objective: 'Not yet specified.',
      success_conditions: [],
    },
    plan: [], completed_work: [], decisions: [], evidence: [], assumptions: [],
    rejected_approaches: [], unknowns: [], blockers: [], risks: [], conflicts: [],
    working_stance: {
      confidence: 'low',
      momentum: 'unknown',
      risk_posture: 'verify-before-change',
      attention: [],
      dissatisfaction: [],
      successor_behavior: [],
    },
    next_actions: [], references: [], extensions: {},
  };
}

function nowIso() {
  return new Date().toISOString();
}

async function currentSnapshotId(jsonPath, options) {
  let raw;
  try { raw = await readFile(jsonPath, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const decoded = decodeEnvelope(raw, { clock: options.clock ?? nowIso(), policy: options.policy });
  if (!decoded.ok) throw storeError('state-unreadable');
  return decoded.state.envelope.snapshot_id;
}

async function readOptional(file) {
  try { return await readFile(file); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function restorePair(json, markdown, previousJson, previousMarkdown) {
  await restoreFile(json, previousJson);
  await restoreFile(markdown, previousMarkdown);
}

async function restoreFile(target, bytes) {
  if (bytes === null) {
    await rm(target, { force: true });
    return;
  }
  const temporary = `${target}.${randomUUID()}.restore`;
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function storeError(code, cause) {
  return Object.assign(new Error(code, { cause }), { code });
}
