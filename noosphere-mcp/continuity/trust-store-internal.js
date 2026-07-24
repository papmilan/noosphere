import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  atomicOwnerOnlyWrite,
  ensureRealDirectoryPath,
  readOwnerOnlyFile,
  writeOwnerOnlyFileExclusive,
} from './secure-fs.js';
import { normalizeUntrusted, NORM_ALGO, NORM_VERSION } from './memory-safety.js';

// SEC-05 Phase 1 — authenticated, out-of-tree trust store (INTERNAL module).
//
// Trust for an owner-authored source slot (master-prompt / instructions /
// followups / baseline) is NEVER inferred from filesystem location, repository
// contents, project metadata, or clone state. It is established only by an
// owner-only record stored OUTSIDE the project tree (under ~/.noosphere/trust),
// authenticated with a machine-local HMAC key, and bound to the exact bytes.
//
// Repository-delivered provenance (anything inside the project tree, anything a
// clone/import/archive could ship) is ignored for trust decisions. Missing,
// unreadable, MAC-invalid, hash-mismatched, wrong-scope, or wrong-identity
// records fail closed: the caller renders the content as quoted, non-
// authoritative data.
//
// M-3 (PR-H): this is the INTERNAL surface. Production code must import only the
// authority-decision interface re-exported from ./trust-store.js. The low-level
// writers (putSlotRecord / ensureProjectIdentity / ensureMachineKey) and helpers
// live here and are test/internal only — they are not production APIs.

export const TRUST_SLOTS = Object.freeze(['master-prompt', 'instructions', 'followups', 'baseline']);

// Historical Phase-1 normalizer identity (the identity function). The running
// normalizer is now (NORM_ALGO, NORM_VERSION) from memory-safety.js; these remain
// exported so a Phase-4 migration can recognize and re-approve legacy 'raw'/0
// records, which fail closed until re-approved (invariant 19).
export const PHASE1_NORM_ALGO = 'raw';
export const PHASE1_NORM_VERSION = 0;

// M-7 (PR-H): authenticated records are small (a fixed schema of hashes and
// scalars). Anything larger than this is malformed or hostile; reject it before
// parsing and fail closed. Generous cap so legitimate records never approach it.
export const MAX_TRUST_RECORD_BYTES = 64 * 1024;

export class TrustStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'TrustStoreError';
  }
}

function homeDir(env) {
  return env.NOOSPHERE_HOME || path.join(os.homedir(), '.noosphere');
}

function trustRoot(env) {
  return path.join(homeDir(env), 'trust');
}

function machineKeyPath(env) {
  return path.join(homeDir(env), 'machine-key');
}

export function ownerScope(env = process.env) {
  if (env.NOOSPHERE_OWNER_SCOPE) return String(env.NOOSPHERE_OWNER_SCOPE);
  try {
    return String(os.userInfo().username);
  } catch {
    // No passwd entry (rare containers): fall back to a stable uid string.
    return `uid:${typeof process.getuid === 'function' ? process.getuid() : 'unknown'}`;
  }
}

function assertSlot(slot) {
  if (!TRUST_SLOTS.includes(slot)) {
    throw new TrustStoreError('invalid-slot', `unknown trust slot: ${slot}`);
  }
  return slot;
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// SEC-05 Phase 2: contentHash is the hash of the NORMALIZED content produced by
// the running registered normalizer (NORM_ALGO, NORM_VERSION); rawHash stays the
// hash of the exact raw bytes. A record binds both, so a normalizer change fails
// closed (its normAlgo/normVersion no longer match) and normalization can never
// launder two different raw byte strings into the same authority.
function normalizedContentHash(bytes) {
  return sha256Hex(Buffer.from(normalizeUntrusted(bytes.toString('utf8')), 'utf8'));
}

// Deterministic, canonical JSON: recursively sorted object keys, no incidental
// whitespace. The MAC is computed over exactly this form, and a stored record is
// only accepted if its raw bytes equal the canonical form of what they parse to —
// so alternate field ordering, extra whitespace, or duplicate keys never verify.
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

async function loadMachineKey(env, secureFileOptions) {
  const raw = await readOwnerOnlyFile(machineKeyPath(env), secureFileOptions).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (raw === null) return null;
  const key = Buffer.from(raw.toString('utf8').trim(), 'hex');
  // A truncated / corrupt key must not silently authenticate anything.
  if (key.length < 32) throw new TrustStoreError('machine-key-corrupt', 'machine key is missing or too short');
  return key;
}

// Generates the machine key if absent (owner-only, out-of-tree, never in any
// repository). Phase 1 exposes this for setup/tests and for later phases; it is
// not wired into any rendering path.
//
// M-1 (PR-H): a present-but-corrupt key fails closed. loadMachineKey returns
// null ONLY for a truly absent (ENOENT) key and throws
// TrustStoreError('machine-key-corrupt') for short/truncated material. That
// throw now propagates instead of being swallowed, so we never regenerate over
// an existing corrupt key — explicit owner reinitialization (removing the
// corrupt key file) is required.
//
// M-6 (PR-H): first creation is exclusive (O_EXCL via
// writeOwnerOnlyFileExclusive). A concurrent creator that wins the race raises
// state-file-exists/EEXIST here; we re-read and adopt the winner's key so all
// racers converge on a single key — no split-brain, no silent overwrite.
export async function ensureMachineKey(env = process.env, secureFileOptions = {}) {
  const existing = await loadMachineKey(env, secureFileOptions); // throws on corrupt (M-1)
  if (existing) return existing;

  await ensureRealDirectoryPath(homeDir(env));
  const key = crypto.randomBytes(32);
  try {
    await writeOwnerOnlyFileExclusive(machineKeyPath(env), `${key.toString('hex')}\n`, secureFileOptions);
    return key;
  } catch (error) {
    if (error.code === 'state-file-exists' || error.code === 'EEXIST') {
      const winner = await loadMachineKey(env, secureFileOptions); // throws on corrupt (M-1)
      if (winner) return winner;
    }
    throw error;
  }
}

async function projectDir(env, projectRoot) {
  let real;
  try {
    real = await fs.realpath(projectRoot);
  } catch {
    real = path.resolve(projectRoot);
  }
  // The realpath is only a *lookup key* for the out-of-tree instance record; it
  // is never the trust anchor (trust = MAC + identity + hash). A clone at a
  // different path finds no record; a path collision still fails on hash/MAC.
  return path.join(trustRoot(env), sha256Hex(real));
}

export async function readRecord(file, secureFileOptions) {
  const raw = await readOwnerOnlyFile(file, secureFileOptions).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (raw === null) return null;
  // M-7: reject oversized records before parsing. Fail closed rather than
  // handing untrusted, unbounded bytes to JSON.parse and the canonical check.
  if (raw.length > MAX_TRUST_RECORD_BYTES) {
    throw new TrustStoreError('record-too-large', `trust record exceeds ${MAX_TRUST_RECORD_BYTES} bytes: ${file}`);
  }
  const text = raw.toString('utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TrustStoreError('record-corrupt', `trust record is not valid JSON: ${file}`);
  }
  // Reject non-canonical encodings (ordering / whitespace / duplicate keys):
  // the stored bytes must equal the canonical form of what they parse to.
  if (text.trim() !== canonicalize(parsed)) {
    throw new TrustStoreError('record-non-canonical', `trust record is not canonically serialized: ${file}`);
  }
  return parsed;
}

function macOf(key, fields) {
  return crypto.createHmac('sha256', key).update(canonicalize(fields)).digest('hex');
}

function macValid(key, record) {
  const { mac, ...fields } = record;
  if (typeof mac !== 'string') return false;
  const expected = macOf(key, fields);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(mac, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Low-level writer for an authenticated slot record. This is the STORAGE half of
// the trust store; it is intentionally NOT an owner-approval workflow (no
// explicit user action, no audit log, no generation-minting policy, no
// byte-display) — that is Phase 4. It exists so the fail-closed gate can be
// exercised end-to-end. M-3 (PR-H): it is internal/test-only and is never
// exposed on the production module surface (./trust-store.js).
export async function putSlotRecord({
  projectRoot,
  slot,
  rawBytes,
  generation = 0,
  env = process.env,
  secureFileOptions = {},
}) {
  assertSlot(slot);
  const key = await ensureMachineKey(env, secureFileOptions);
  const identity = await ensureProjectIdentity({ projectRoot, env, secureFileOptions });
  const bytes = Buffer.isBuffer(rawBytes) ? rawBytes : Buffer.from(String(rawBytes), 'utf8');
  const fields = {
    projectIdentity: identity.projectIdentity,
    ownerScope: ownerScope(env),
    slot,
    generation,
    contentHash: normalizedContentHash(bytes), // hash of normalized content
    rawHash: sha256Hex(bytes), // hash of the exact raw bytes
    normAlgo: NORM_ALGO,
    normVersion: NORM_VERSION,
  };
  const record = { ...fields, mac: macOf(key, fields) };
  const dir = await projectDir(env, projectRoot);
  await ensureRealDirectoryPath(dir);
  await atomicOwnerOnlyWrite(path.join(dir, `${slot}.json`), canonicalize(record), secureFileOptions);
  return record;
}

async function loadProjectIdentity({ projectRoot, env, secureFileOptions }) {
  const dir = await projectDir(env, projectRoot);
  const record = await readRecord(path.join(dir, 'instance.json'), secureFileOptions);
  if (record === null) return null;
  const key = await loadMachineKey(env, secureFileOptions);
  if (!key || !macValid(key, record)) return null;
  if (record.ownerScope !== ownerScope(env)) return null;
  return record;
}

// Mints the owner-only, out-of-tree project-instance identity if absent. The
// identity is a random value the owner mints locally; repository-controlled data
// never determines it. A fresh clone in a new location has no instance record
// and is therefore completely untrusted. M-3 (PR-H): internal/test-only.
export async function ensureProjectIdentity({ projectRoot, env = process.env, secureFileOptions = {} }) {
  const existing = await loadProjectIdentity({ projectRoot, env, secureFileOptions }).catch(() => null);
  if (existing) return existing;
  const key = await ensureMachineKey(env, secureFileOptions);
  const fields = {
    projectIdentity: crypto.randomUUID(),
    ownerScope: ownerScope(env),
    createdAt: new Date().toISOString(),
  };
  const record = { ...fields, mac: macOf(key, fields) };
  const dir = await projectDir(env, projectRoot);
  await ensureRealDirectoryPath(dir);
  await atomicOwnerOnlyWrite(path.join(dir, 'instance.json'), canonicalize(record), secureFileOptions);
  return record;
}

// THE authority decision. Returns true only when an authenticated out-of-tree
// owner record exists for the exact bytes of this slot: MAC valid under this
// machine's key, matching project instance identity, matching owner scope,
// matching slot, matching contentHash + rawHash, matching (normAlgo,
// normVersion). Any missing precondition, any error, fails closed to false.
//
// M-5 (Phase 2): the normalizer identity is NOT a caller parameter. It is pinned
// to the running registered normalizer (NORM_ALGO, NORM_VERSION); a record minted
// under a different (older) normalizer no longer matches and fails closed
// (invariant 19). A caller cannot select or downgrade the normalization.
export async function isSlotAuthoritative({
  projectRoot,
  slot,
  rawBytes,
  env = process.env,
  secureFileOptions = {},
}) {
  try {
    assertSlot(slot);
    const key = await loadMachineKey(env, secureFileOptions);
    if (!key) return false;

    const identity = await loadProjectIdentity({ projectRoot, env, secureFileOptions });
    if (!identity) return false;

    const dir = await projectDir(env, projectRoot);
    const record = await readRecord(path.join(dir, `${slot}.json`), secureFileOptions);
    if (!record) return false;

    if (!macValid(key, record)) return false;
    if (record.projectIdentity !== identity.projectIdentity) return false;
    if (record.ownerScope !== ownerScope(env)) return false;
    if (record.slot !== slot) return false;
    // M-5: pin to the running registered normalizer, not a caller value.
    if (record.normAlgo !== NORM_ALGO || record.normVersion !== NORM_VERSION) return false;
    if (!Number.isInteger(record.generation) || record.generation < 0) return false;

    const bytes = Buffer.isBuffer(rawBytes) ? rawBytes : Buffer.from(String(rawBytes ?? ''), 'utf8');
    // rawHash binds the exact raw bytes; contentHash binds the normalized content
    // under the pinned (normAlgo, normVersion). Both must match.
    if (record.rawHash !== sha256Hex(bytes)) return false;
    if (record.contentHash !== normalizedContentHash(bytes)) return false;

    // ponytail: generation is schema-bound and MAC-protected here; the
    // current-generation / anti-rollback comparison lands with owner approval and
    // restore in Phase 4 (a single on-disk record is treated as current in Phase 1).
    return true;
  } catch {
    return false; // fail closed on any error
  }
}
