// Execution checkpoints are isolated by a canonical agent id.  The storage
// layer never chooses an agent from a pathname, and a short exclusive lock
// prevents two writers from silently replacing one another's checkpoint.

import { createHash } from 'node:crypto';
import { open, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { canonicalize } from '@noosphere/acp-protocol';
import { createExecutionState } from './execution-state.js';
import { renderExecutionKernel } from './execution-render.js';
import {
  ensureContainedDir,
  atomicOwnerOnlyWrite,
  readBoundedRegularFile,
  readOwnerOnlyFile,
  removeRepositoryFile,
} from '../secure-fs.js';

const DEFAULT_AGENT_ID = 'default';
const AGENT_ID = /^[a-z0-9](?:[a-z0-9-]{0,62})?$/;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

export function canonicalAgentId(value = DEFAULT_AGENT_ID) {
  if (typeof value !== 'string' || value.normalize('NFC') !== value) throw executionError('invalid-agent-id');
  const canonical = value.toLowerCase();
  if (!AGENT_ID.test(canonical)) throw executionError('invalid-agent-id');
  return canonical;
}

export function executionPaths(root, agentId = DEFAULT_AGENT_ID) {
  const agent = canonicalAgentId(agentId);
  const dir = path.join(root, '.noosphere', 'execution');
  const base = path.join(dir, agent);
  return {
    agent,
    dir,
    json: `${base}.json`,
    markdown: `${base}.md`,
    lock: `${base}.lock`,
    generation: `${base}.generation`,
  };
}

export async function executionGeneration(root, agentId = DEFAULT_AGENT_ID) {
  return readGeneration(executionPaths(root, agentId).generation);
}

export async function readExecutionState(root, options = {}) {
  const { json } = executionPaths(root, options.agentId);
  const bytes = await readOwnerOnlyFile(json, secureOptions(root, options));
  if (bytes === null) return null;
  let raw;
  try {
    raw = UTF8.decode(bytes);
  } catch {
    return { ok: false, errors: [{ path: '$', code: 'invalid-utf8', message: 'execution checkpoint is not valid UTF-8' }] };
  }
  let envelope;
  try { envelope = JSON.parse(raw); } catch {
    return { ok: false, errors: [{ path: '$', code: 'malformed-json', message: 'execution checkpoint is not valid JSON' }] };
  }
  const digestErrors = verifyDigest(envelope);
  if (digestErrors.length) return { ok: false, errors: digestErrors };
  return createExecutionState(envelope, { clock: options.now, policy: options.policy });
}

export async function listExecutionStates(root, options = {}) {
  const dir = path.join(root, '.noosphere', 'execution');
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const agents = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name.slice(0, -'.json'.length))
    .filter((agent) => AGENT_ID.test(agent))
    .sort();
  return Promise.all(agents.map(async (agentId) => ({ agentId, result: await readExecutionState(root, { ...options, agentId }) })));
}

export async function writeExecutionState(root, envelope, options = {}) {
  const agentId = canonicalAgentId(options.agentId ?? DEFAULT_AGENT_ID);
  const decoded = createExecutionState(envelope, { clock: options.now, policy: options.policy });
  if (!decoded.ok) throw new Error(`Invalid execution state: ${decoded.errors.map(({ path: p, code }) => `${p} ${code}`).join('; ')}`);
  const paths = executionPaths(root, agentId);
  return withAgentLock(root, paths, async () => {
    const generation = await readGeneration(paths.generation);
    if (options.expectedGeneration != null && options.expectedGeneration !== generation) throw executionError('checkpoint-cleared');
    const previous = await readExecutionState(root, {
      agentId,
      now: options.now,
      policy: options.policy,
      secureFileOptions: options.secureFileOptions,
    });
    if (previous?.ok && previous.state.envelope.origin.agent_id !== envelope.origin.agent_id) {
      throw executionError('agent-id-collision');
    }
    const sealed = sealEnvelope(decoded.state.envelope);
    const verdict = options.verdict ?? defaultVerdict(decoded.state.envelope);
    const kernel = renderExecutionKernel({ envelope: sealed }, {
      verdict, now: options.now ?? new Date().toISOString(), contention: options.contention ?? [],
    });
    await atomicOwnerOnlyWrite(
      paths.json,
      `${JSON.stringify(sealed, null, 2)}\n`,
      { ...secureOptions(root, options), rename: options.rename },
    );
    await atomicOwnerOnlyWrite(
      paths.markdown,
      `${kernel}\n`,
      { ...secureOptions(root, options), rename: options.rename },
    );
    return { envelope: sealed, kernel, verdict, agentId, generation };
  });
}

export async function clearExecutionState(root, agentId = DEFAULT_AGENT_ID) {
  const paths = executionPaths(root, agentId);
  return withAgentLock(root, paths, async () => {
    const nextGeneration = (await readGeneration(paths.generation)) + 1;
    await atomicOwnerOnlyWrite(paths.generation, `${nextGeneration}\n`, { root });
    await removeRepositoryFile(paths.json, { root });
    await removeRepositoryFile(paths.markdown, { root });
    return { agentId: paths.agent, generation: nextGeneration };
  });
}

async function withAgentLock(root, paths, action) {
  await ensureContainedDir(root, paths.dir);
  let handle;
  try { handle = await open(paths.lock, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw executionError('execution-write-in-progress'); throw error; }
  try { return await action(); }
  finally { await handle.close().catch(() => {}); await rm(paths.lock, { force: true }).catch(() => {}); }
}

async function readGeneration(file) {
  try {
    const bytes = await readBoundedRegularFile(file, { maxBytes: 64 });
    if (bytes === null) return 0;
    const value = Number(bytes.toString('utf8').trim());
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
}

function sealEnvelope(envelope) {
  const sealed = structuredClone(envelope);
  sealed.integrity = { ...sealed.integrity, digest: digestExecutionEnvelope(sealed) };
  return sealed;
}

function digestExecutionEnvelope(envelope) {
  const clone = structuredClone(envelope);
  clone.integrity = { ...clone.integrity, digest: '0'.repeat(64) };
  if (clone.integrity.signature) clone.integrity.signature = { ...clone.integrity.signature, value: null };
  return createHash('sha256').update(canonicalize(clone), 'utf8').digest('hex');
}

function verifyDigest(envelope) {
  if (typeof envelope !== 'object' || envelope === null || typeof envelope.integrity?.digest !== 'string') {
    return [{ path: '$.integrity.digest', code: 'digest-mismatch', message: 'missing integrity digest' }];
  }
  return digestExecutionEnvelope(envelope) === envelope.integrity.digest ? []
    : [{ path: '$.integrity.digest', code: 'digest-mismatch', message: 'execution state does not match its integrity digest' }];
}

function defaultVerdict(envelope) {
  return {
    binding: 'fresh', aged: false, historyOnly: false, actionable: true,
    steps: Object.fromEntries(envelope.steps.map((step) => [step.id, step.target.content_hash == null ? 'unknown' : 'target-unchanged'])), reasons: [],
  };
}

function executionError(code) { return Object.assign(new Error(code), { code }); }

function secureOptions(root, options = {}) {
  return { ...(options.secureFileOptions || {}), root };
}
