import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
  return withStateLock(root, async () => {
    await recoverStateTransaction(root);
    return readStateUnlocked(root, options);
  });
}

async function readStateUnlocked(root, options = {}) {
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
  return withStateLock(root, async () => {
    await recoverStateTransaction(root);
    return writeStateUnlocked(root, state, options);
  });
}

async function writeStateUnlocked(root, state, options = {}) {
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
  return withStateLock(root, async () => {
    await recoverStateTransaction(root);
    return writeStateIfCurrentLocked(root, state, expectedSnapshotId, options);
  });
}

async function writeStateIfCurrentLocked(root, state, expectedSnapshotId, options = {}) {
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
  const names = {
    newJson: `.continuity-txn-${token}-json.new`,
    newMarkdown: `.continuity-txn-${token}-markdown.new`,
    backupJson: `.continuity-txn-${token}-json.backup`,
    backupMarkdown: `.continuity-txn-${token}-markdown.backup`,
  };
  const jsonTmp = path.join(dir, names.newJson);
  const mdTmp = path.join(dir, names.newMarkdown);
  const previousJson = await readOptional(json);
  const previousMarkdown = await readOptional(markdown);
  const renameForCommit = options.rename ?? rename;
  const journal = {
    version: 1, token, phase: 'prepared', ...names,
    hadJson: previousJson !== null,
    hadMarkdown: previousMarkdown !== null,
  };
  try {
    await writeFile(jsonTmp, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await writeFile(mdTmp, `${kernel}\n`, { mode: 0o600, flag: 'wx' });
    if (previousJson !== null) await writeFile(path.join(dir, names.backupJson), previousJson, { mode: 0o600, flag: 'wx' });
    if (previousMarkdown !== null) await writeFile(path.join(dir, names.backupMarkdown), previousMarkdown, { mode: 0o600, flag: 'wx' });
    await syncTransactionFiles(dir, journal);
    await writeTransactionJournal(dir, journal);
    await options.phaseHook?.('prepared');
    const currentId = await currentSnapshotId(json, options);
    if (currentId !== expectedSnapshotId) throw storeError('confirmation-stale');
    journal.phase = 'committing';
    await writeTransactionJournal(dir, journal);
    await options.phaseHook?.('committing');
    await renameForCommit(jsonTmp, json);
    journal.phase = 'json-committed';
    await writeTransactionJournal(dir, journal);
    await options.phaseHook?.('json-committed');
    await renameForCommit(mdTmp, markdown);
    journal.phase = 'committed';
    await writeTransactionJournal(dir, journal);
    await options.phaseHook?.('committed');
    await cleanupTransaction(dir, journal);
  } catch (error) {
    if (error.simulatedCrash) throw error;
    try { await recoverStateTransaction(root); }
    catch (rollbackError) { throw storeError('state-rollback-failed', new AggregateError([error, rollbackError])); }
    for (const name of Object.values(names)) await rm(path.join(dir, name), { force: true }).catch(() => undefined);
    throw error;
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

async function recoverStateTransaction(root) {
  const { dir, json, markdown } = statePaths(root);
  const journalPath = path.join(dir, '.continuity-transaction.json');
  let journal;
  try { journal = JSON.parse(await readFile(journalPath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    throw storeError('state-transaction-invalid', error);
  }
  validateJournal(journal);
  if (journal.phase !== 'committed') {
    const backupJson = journal.hadJson ? await readFile(path.join(dir, journal.backupJson)) : null;
    const backupMarkdown = journal.hadMarkdown ? await readFile(path.join(dir, journal.backupMarkdown)) : null;
    await restoreFile(json, backupJson);
    await restoreFile(markdown, backupMarkdown);
  }
  await cleanupTransaction(dir, journal);
}

async function cleanupTransaction(dir, journal) {
  for (const name of [journal.newJson, journal.newMarkdown, journal.backupJson, journal.backupMarkdown, '.continuity-transaction.json']) {
    await rm(path.join(dir, name), { force: true });
  }
  await syncDirectory(dir);
}

async function writeTransactionJournal(dir, journal) {
  const target = path.join(dir, '.continuity-transaction.json');
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(journal)}\n`, { mode: 0o600, flag: 'wx' });
    await syncFile(temporary);
    await rename(temporary, target);
    await syncDirectory(dir);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function syncTransactionFiles(dir, journal) {
  for (const name of [journal.newJson, journal.newMarkdown, journal.hadJson && journal.backupJson, journal.hadMarkdown && journal.backupMarkdown].filter(Boolean)) {
    await syncFile(path.join(dir, name));
  }
  await syncDirectory(dir);
}

function validateJournal(journal) {
  const phases = new Set(['prepared', 'committing', 'json-committed', 'committed']);
  if (journal?.version !== 1 || typeof journal.token !== 'string' || !phases.has(journal.phase)
    || typeof journal.hadJson !== 'boolean' || typeof journal.hadMarkdown !== 'boolean') {
    throw storeError('state-transaction-invalid');
  }
  for (const [key, suffix] of [['newJson', '-json.new'], ['newMarkdown', '-markdown.new'], ['backupJson', '-json.backup'], ['backupMarkdown', '-markdown.backup']]) {
    if (journal[key] !== `.continuity-txn-${journal.token}${suffix}`) throw storeError('state-transaction-invalid');
  }
}

async function withStateLock(root, operation) {
  const dir = statePaths(root).dir;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const lockPath = path.join(dir, '.continuity-state.lock');
  const token = randomUUID();
  let handle;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, created_at: Date.now() }));
      await handle.sync();
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await staleStateLock(lockPath)) await rm(lockPath, { force: true });
      else await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (!handle) throw storeError('state-lock-timeout');
  try { return await operation(); } finally {
    await handle.close();
    const current = await readFile(lockPath, 'utf8').then(JSON.parse).catch(() => null);
    if (current?.token === token) await rm(lockPath, { force: true });
  }
}

async function staleStateLock(lockPath) {
  const lock = await readFile(lockPath, 'utf8').then(JSON.parse).catch(() => null);
  if (!lock || !Number.isInteger(lock.pid)) {
    const details = await lstat(lockPath).catch(() => null);
    return details !== null && Date.now() - details.mtimeMs > 60_000;
  }
  try { process.kill(lock.pid, 0); return Date.now() - Number(lock.created_at || 0) > 60_000; }
  catch (error) { return error.code === 'ESRCH'; }
}

async function syncFile(file) { const handle = await open(file, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
async function syncDirectory(dir) { const handle = await open(dir, 'r'); try { await handle.sync(); } finally { await handle.close(); } }

function storeError(code, cause) {
  return Object.assign(new Error(code, { cause }), { code });
}
