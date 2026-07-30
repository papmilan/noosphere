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

async function readStableOwnerOnly(file, {
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

async function replayRootEntries(env, secureFileOptions) {
  const root = replayRootPath(env);
  const contained = await assertContainedChain(homeDir(env), root);
  if (contained === null) return null;
  await inspectOwnerOnlyDestination(
    replayKeyPath(env),
    {
      ...secureFileOptions,
      maxBytes: KEY_FILE_BYTES,
    },
  );
  return fs.readdir(root);
}

async function readAndVerifyCatalog({
  env,
  key,
  secureFileOptions,
}) {
  let lastError;
  for (let attempt = 0; attempt < 32; attempt += 1) {
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
      if (![
        'state-file-changed',
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
  await inspectOwnerOnlyDestination(replayKeyPath(env), {
    ...secureFileOptions,
    maxBytes: KEY_FILE_BYTES,
  });
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
