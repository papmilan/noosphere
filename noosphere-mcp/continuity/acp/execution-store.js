// Atomic persistence for the execution checkpoint: canonical
// .noosphere/execution.json plus its derived advisory kernel
// .noosphere/execution.md, written temp-then-rename with owner-only
// permissions. Both files are generated artifacts inside the ignored
// .noosphere directory, so a checkpoint never perturbs the workspace
// fingerprint. Single writer per agent; the previous checkpoint is replaced
// whole, and a failed write leaves it untouched.

import { mkdir, readFile, rename as fsRename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalize } from '@noosphere/acp-protocol';
import { createHash } from 'node:crypto';
import { createExecutionState } from './execution-state.js';
import { renderExecutionKernel } from './execution-render.js';

const JSON_FILE = 'execution.json';
const MD_FILE = 'execution.md';

export function executionPaths(root) {
  const dir = path.join(root, '.noosphere');
  return { dir, json: path.join(dir, JSON_FILE), markdown: path.join(dir, MD_FILE) };
}

export async function readExecutionState(root, options = {}) {
  const { json } = executionPaths(root);
  let raw;
  try {
    raw = await readFile(json, 'utf8');
  } catch {
    return null;
  }
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return { ok: false, errors: [{ path: '$', code: 'malformed-json', message: 'execution.json is not valid JSON' }] };
  }
  const digestErrors = verifyDigest(envelope);
  if (digestErrors.length) return { ok: false, errors: digestErrors };
  return createExecutionState(envelope, { clock: options.now });
}

export async function writeExecutionState(root, envelope, options = {}) {
  const decoded = createExecutionState(envelope, { clock: options.now });
  if (!decoded.ok) {
    throw new Error(`Invalid execution state: ${decoded.errors.map(({ path: p, code }) => `${p} ${code}`).join('; ')}`);
  }
  const sealed = sealEnvelope(decoded.state.envelope);
  const verdict = options.verdict ?? defaultVerdict(decoded.state.envelope);
  const kernel = renderExecutionKernel({ envelope: sealed }, {
    verdict,
    now: options.now ?? new Date().toISOString(),
    contention: options.contention ?? [],
  });

  const { dir, json, markdown } = executionPaths(root);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const rename = options.rename ?? fsRename;
  const jsonTmp = `${json}.${process.pid}.tmp`;
  const mdTmp = `${markdown}.${process.pid}.tmp`;
  try {
    await writeFile(jsonTmp, `${JSON.stringify(sealed, null, 2)}\n`, { mode: 0o600 });
    await writeFile(mdTmp, `${kernel}\n`, { mode: 0o600 });
    await rename(jsonTmp, json);
    await rename(mdTmp, markdown);
  } finally {
    await rm(jsonTmp, { force: true }).catch(() => {});
    await rm(mdTmp, { force: true }).catch(() => {});
  }
  return { envelope: sealed, kernel, verdict };
}

export async function clearExecutionState(root) {
  const { json, markdown } = executionPaths(root);
  await rm(json, { force: true });
  await rm(markdown, { force: true });
}

// The checkpoint is content-addressed like every ACP artifact: the digest is
// computed over the canonical envelope minus its own derived fields, so any
// post-write tampering is detected on read.
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
  if (digestExecutionEnvelope(envelope) !== envelope.integrity.digest) {
    return [{ path: '$.integrity.digest', code: 'digest-mismatch', message: 'execution state does not match its integrity digest' }];
  }
  return [];
}

// Writing our own fresh checkpoint: binding to the snapshot we just observed
// is fresh by construction; per-step verdicts default to fresh. Resume-time
// classification with real repository inputs happens in the CLI, not here.
function defaultVerdict(envelope) {
  return {
    binding: 'fresh',
    aged: false,
    historyOnly: false,
    actionable: true,
    steps: Object.fromEntries(envelope.steps.map((step) => [step.id, 'fresh'])),
    reasons: [],
  };
}
