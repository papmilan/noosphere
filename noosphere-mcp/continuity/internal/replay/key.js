import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  assertContainedChain,
  ensureRealDirectoryPath,
  inspectOwnerOnlyDestination,
  readBoundedRegularFile,
  writeOwnerOnlyFileExclusive,
} from '../../secure-fs.js';
import {
  TrustStoreError,
  canonicalize,
  homeDir,
} from '../../trust-store-internal.js';
import {
  AUTH_DOMAINS,
  sealRecord,
} from '../authenticated-records.js';
import {
  REPLAY_KEY_BYTES,
  REPLAY_KEY_HEX_BYTES,
  REPLAY_METADATA_BYTES,
} from './constants.js';
import { parseReplayCatalog } from './schema.js';

const KEY_FILE_BYTES = REPLAY_KEY_HEX_BYTES + 1;

// The three ways "a concurrent writer replaced this file while I was reading
// it" reaches us. During pristine first use every agent racing to create the
// key and catalog produces exactly this, so refusing on it turns ordinary
// concurrency into a hard failure — the observed symptom was a ~40% failure
// rate creating a key from several processes at once.
//
// These say the bytes moved, never that they are untrusted: an ownership, ACL,
// or containment violation raises a different code and still propagates on the
// first occurrence. Every retry re-reads and re-authenticates from scratch, so
// a genuinely corrupt or hostile file keeps failing and still ends up thrown.
const TRANSIENT_READ_CODES = new Set([
  // secure-fs: file identity changed between opening and reading it.
  'state-file-changed',
  // secure-fs: the lstat snapshot moved across an inspection.
  'state-destination-changed',
  // this module: the bytes differed between the two stable-read inspections.
  'replay-state-changed',
]);

const READ_RETRY_ATTEMPTS = 32;

// Retry an owner-only read for as long as a writer keeps moving the file
// underneath it. Bounded: a writer that never settles fails closed with the
// last error rather than spinning forever.
async function retryWhileChanging(operation) {
  let lastError;
  for (let attempt = 0; attempt < READ_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!TRANSIENT_READ_CODES.has(error.code)) throw error;
      lastError = error;
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  throw lastError;
}

function replayKeyError(code, message) {
  return new TrustStoreError(code, message);
}

export function replayRootPath(env = process.env) {
  return path.join(homeDir(env), 'replay-v1');
}

export function replayKeyPath(env = process.env) {
  return path.join(replayRootPath(env), 'machine.key');
}

function replayCatalogPath(env) {
  return path.join(replayRootPath(env), 'catalog.json');
}

export function replayKeyId(key) {
  if (!Buffer.isBuffer(key) || key.length !== REPLAY_KEY_BYTES) {
    throw new TypeError('replay key must be exactly 256 bits');
  }
  return createHash('sha256').update(key).digest('hex');
}

function decodeReplayKey(raw) {
  const text = raw.toString('utf8');
  const material = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (
    material.length !== REPLAY_KEY_HEX_BYTES ||
    !/^[0-9a-f]{64}$/.test(material) ||
    text !== `${material}\n`
  ) {
    throw replayKeyError(
      'replay-key-corrupt',
      'replay key is not canonical lowercase 256-bit hex',
    );
  }
  const key = Buffer.from(material, 'hex');
  if (
    key.length !== REPLAY_KEY_BYTES ||
    key.toString('hex') !== material
  ) {
    throw replayKeyError(
      'replay-key-corrupt',
      'replay key is not exactly 256 bits',
    );
  }
  return key;
}

// One attempt at a torn-free read: inspect, read, inspect, and refuse unless
// all three agree. Callers go through readStableOwnerOnly, which retries this
// while a concurrent writer keeps changing the answer.
async function readStableOwnerOnlyOnce(file, {
  maxBytes,
  secureFileOptions,
}) {
  const options = {
    ...secureFileOptions,
    maxBytes,
  };
  const before = await inspectOwnerOnlyDestination(file, options);
  if (before.state === 'absent') return null;
  const raw = await readBoundedRegularFile(file, { maxBytes });
  const after = await inspectOwnerOnlyDestination(file, options);
  const digest = createHash('sha256').update(raw).digest('hex');
  if (
    after.state !== 'present' ||
    before.contentHash !== digest ||
    after.contentHash !== digest ||
    before.byteLength !== raw.length ||
    after.byteLength !== raw.length
  ) {
    throw replayKeyError(
      'replay-state-changed',
      'replay state changed while it was being read',
    );
  }
  return raw;
}

function readStableOwnerOnly(file, options) {
  return retryWhileChanging(() => readStableOwnerOnlyOnce(file, options));
}

async function replayRootEntries(env, secureFileOptions) {
  const root = replayRootPath(env);
  const contained = await assertContainedChain(homeDir(env), root);
  if (contained === null) return null;
  // The key is being created by a peer as often as not during first use, so
  // this boundary check races exactly like the reads below it.
  await retryWhileChanging(() =>
    inspectOwnerOnlyDestination(
      replayKeyPath(env),
      {
        ...secureFileOptions,
        maxBytes: KEY_FILE_BYTES,
      },
    ),
  );
  return fs.readdir(root);
}

async function readAndVerifyCatalog({
  env,
  key,
  secureFileOptions,
}) {
  let lastError;
  for (let attempt = 0; attempt < READ_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const raw = await readStableOwnerOnly(replayCatalogPath(env), {
        maxBytes: REPLAY_METADATA_BYTES,
        secureFileOptions,
      });
      if (raw === null) return null;
      return parseReplayCatalog(raw, {
        key,
        expectedKeyId: replayKeyId(key),
      });
    } catch (error) {
      // Reads that tore mid-flight are absorbed by readStableOwnerOnly. What
      // reaches here is a catalog that parsed as damaged — which a peer part
      // way through writing it also looks like, so re-read once it settles.
      // A truly corrupt catalog fails every attempt and is thrown below.
      if (![
        'record-corrupt',
        'record-non-canonical',
      ].includes(error.code)) {
        throw error;
      }
      lastError = error;
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  throw lastError;
}

export async function loadReplayKey({
  env = process.env,
  secureFileOptions = {},
} = {}) {
  const entries = await replayRootEntries(env, secureFileOptions);
  if (entries === null) return null;
  const raw = await readStableOwnerOnly(replayKeyPath(env), {
    maxBytes: KEY_FILE_BYTES,
    secureFileOptions,
  });
  if (raw === null) {
    if (entries.length === 0) return null;
    throw replayKeyError(
      'replay-key-missing-with-state',
      'replay key is missing while replay state survives',
    );
  }
  const key = decodeReplayKey(raw);
  const catalog = await readAndVerifyCatalog({
    env,
    key,
    secureFileOptions,
  });
  const nonKeyEntries = entries.filter(entry => entry !== 'machine.key');
  if (catalog === null && nonKeyEntries.length > 0) {
    throw replayKeyError(
      'replay-catalog-missing-with-state',
      'replay catalog is missing while replay state survives',
    );
  }
  return key;
}

async function ensureInitialCatalog({
  env,
  key,
  secureFileOptions,
}) {
  const existing = await readAndVerifyCatalog({
    env,
    key,
    secureFileOptions,
  });
  if (existing !== null) return;
  const root = replayRootPath(env);
  const entries = await fs.readdir(root);
  if (entries.some(entry => entry !== 'machine.key')) {
    throw replayKeyError(
      'replay-catalog-missing-with-state',
      'refusing to initialize a catalog over surviving replay state',
    );
  }
  const catalog = sealRecord(key, AUTH_DOMAINS.replayCatalog, {
    domain: AUTH_DOMAINS.replayCatalog,
    schema: 'noosphere.replay-catalog',
    version: 1,
    projects: [],
    keyId: replayKeyId(key),
  });
  try {
    await writeOwnerOnlyFileExclusive(
      replayCatalogPath(env),
      canonicalize(catalog),
      {
        ...secureFileOptions,
        root: homeDir(env),
      },
    );
  } catch (error) {
    if (error.code !== 'state-file-exists' && error.code !== 'EEXIST') {
      throw error;
    }
    await readAndVerifyCatalog({ env, key, secureFileOptions });
  }
}

export async function ensureReplayKey({
  env = process.env,
  secureFileOptions = {},
} = {}) {
  const existing = await loadReplayKey({ env, secureFileOptions });
  if (existing !== null) {
    await ensureInitialCatalog({
      env,
      key: existing,
      secureFileOptions,
    });
    return existing;
  }

  await ensureRealDirectoryPath(homeDir(env));
  await inspectOwnerOnlyDestination(
    path.join(homeDir(env), '.replay-v1-boundary-probe'),
    {
      ...secureFileOptions,
      maxBytes: 0,
    },
  );
  await ensureRealDirectoryPath(replayRootPath(env));
  // Racing peers are creating this very file, so tolerate it moving here too.
  // Losing the creation race below is already handled; failing this inspection
  // would reject the loser before it ever gets the chance to re-read.
  await retryWhileChanging(() =>
    inspectOwnerOnlyDestination(replayKeyPath(env), {
      ...secureFileOptions,
      maxBytes: KEY_FILE_BYTES,
    }),
  );
  const entries = await fs.readdir(replayRootPath(env));
  if (entries.length !== 0) {
    throw replayKeyError(
      'replay-key-missing-with-state',
      'refusing replay-key creation in a non-pristine replay root',
    );
  }

  const candidate = randomBytes(REPLAY_KEY_BYTES);
  let key = candidate;
  try {
    await writeOwnerOnlyFileExclusive(
      replayKeyPath(env),
      `${candidate.toString('hex')}\n`,
      {
        ...secureFileOptions,
        root: homeDir(env),
      },
    );
  } catch (error) {
    if (error.code !== 'state-file-exists' && error.code !== 'EEXIST') {
      throw error;
    }
    key = await loadReplayKey({ env, secureFileOptions });
    if (key === null) throw error;
  }
  await ensureInitialCatalog({ env, key, secureFileOptions });
  return key;
}
