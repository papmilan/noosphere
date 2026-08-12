import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  atomicOwnerOnlyWrite,
  ensureRealDirectoryPath,
  readBoundedRegularFile,
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
  REPLAY_METADATA_BYTES,
  REPLAY_RECORD_BYTES,
} from './constants.js';
import {
  ensureReplayKey,
  replayKeyId,
  replayRootPath,
} from './key.js';
import {
  acquireReplayCatalogLock,
} from './lock.js';
import {
  createRankedLockScope,
  releaseHeldLocks,
} from './lock-ranks.js';
import {
  parseReplayCatalog,
  parseReplayManifest,
  parseReplayRecord,
} from './schema.js';

const SHA256_ID = /^sha256:[0-9a-f]{64}$/;

function storeError(code, message) {
  return new TrustStoreError(code, message);
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function replayArtifactDigest(record) {
  return sha256(Buffer.from(canonicalize(
    record === null ? ['noosphere.replay.absent.v1'] : record,
  ), 'utf8'));
}

export function replayRecordIndexDigest(records) {
  const entries = [...records]
    .sort((left, right) =>
      left.replayIdentity.localeCompare(right.replayIdentity))
    .map(record => [
      record.replayIdentity,
      record.recordGeneration,
      record.mac,
    ]);
  return sha256(Buffer.from(canonicalize(entries), 'utf8'));
}

function digestSegment(value) {
  if (!SHA256_ID.test(value)) {
    throw storeError('replay-project-invalid', 'replay project identity is invalid');
  }
  return value.slice(7);
}

export function replayProjectPaths({
  env = process.env,
  projectIdentityDigest,
}) {
  const project = path.join(
    replayRootPath(env),
    'projects',
    digestSegment(projectIdentityDigest),
  );
  return Object.freeze({
    project,
    manifest: path.join(project, 'manifest.json'),
    records: path.join(project, 'records'),
    locks: path.join(project, 'locks'),
    journals: path.join(project, 'journals'),
    retention: path.join(project, 'retention'),
  });
}

async function readRequired(file, maxBytes, code) {
  const raw = await readBoundedRegularFile(file, { maxBytes });
  if (raw === null) throw storeError(code, `required replay state is missing: ${file}`);
  return raw;
}

async function readCatalog({ env, key }) {
  const raw = await readRequired(
    path.join(replayRootPath(env), 'catalog.json'),
    REPLAY_METADATA_BYTES,
    'replay-catalog-missing',
  );
  return parseReplayCatalog(raw, {
    key,
    expectedKeyId: replayKeyId(key),
  });
}

async function writeAuthenticated(file, record, env) {
  await atomicOwnerOnlyWrite(file, canonicalize(record), {
    root: homeDir(env),
    maxBytes: REPLAY_METADATA_BYTES,
  });
}

export async function writeReplayManifest({
  env = process.env,
  projectIdentityDigest,
  manifest,
}) {
  const paths = replayProjectPaths({ env, projectIdentityDigest });
  await writeAuthenticated(paths.manifest, manifest, env);
}

export async function markReplayRecovery({
  env = process.env,
  key,
  projectIdentityDigest,
  recoveredAt = new Date().toISOString(),
}) {
  const prior = await readReplayManifest({
    env,
    key,
    projectIdentityDigest,
  });
  const manifest = sealRecord(key, AUTH_DOMAINS.replayManifest, {
    ...prior,
    lastRecoveredAt: recoveredAt,
    mac: undefined,
  });
  await writeReplayManifest({ env, projectIdentityDigest, manifest });
  return manifest;
}

export async function writeReplayRecord({
  env = process.env,
  projectIdentityDigest,
  record,
}) {
  const paths = replayProjectPaths({ env, projectIdentityDigest });
  const file = path.join(
    paths.records,
    `${digestSegment(record.replayIdentity)}.json`,
  );
  await atomicOwnerOnlyWrite(file, canonicalize(record), {
    root: homeDir(env),
    maxBytes: REPLAY_RECORD_BYTES,
  });
}

function initialManifest(key, projectIdentityDigest) {
  return sealRecord(key, AUTH_DOMAINS.replayManifest, {
    domain: AUTH_DOMAINS.replayManifest,
    schema: 'noosphere.replay-manifest',
    version: 1,
    projectIdentityDigest,
    recordCount: 0,
    recordIndexDigest: sha256(Buffer.from(canonicalize([]), 'utf8')),
    retentionGeneration: 0,
    retentionCheckpointDigest: null,
    lastRecoveredAt: null,
    keyId: replayKeyId(key),
  });
}

export async function ensureReplayProject({
  env = process.env,
  projectIdentityDigest,
}) {
  const key = await ensureReplayKey({ env });
  const scope = createRankedLockScope();
  const catalogLock = await acquireReplayCatalogLock({ scope, env, key });
  let operationFailure;
  try {
    const catalog = await readCatalog({ env, key });
    const paths = replayProjectPaths({ env, projectIdentityDigest });
    await ensureRealDirectoryPath(paths.records);
    await ensureRealDirectoryPath(paths.locks);
    await ensureRealDirectoryPath(paths.journals);
    await ensureRealDirectoryPath(paths.retention);
    const manifestRaw = await readBoundedRegularFile(paths.manifest, {
      maxBytes: REPLAY_METADATA_BYTES,
    });
    if (manifestRaw === null) {
      if (catalog.projects.includes(projectIdentityDigest)) {
        throw storeError(
          'replay-project-missing',
          'catalog names a project whose replay manifest is absent',
        );
      }
      await writeAuthenticated(
        paths.manifest,
        initialManifest(key, projectIdentityDigest),
        env,
      );
    } else {
      parseReplayManifest(manifestRaw, {
        key,
        expectedProjectIdentityDigest: projectIdentityDigest,
        expectedKeyId: replayKeyId(key),
      });
    }
    if (!catalog.projects.includes(projectIdentityDigest)) {
      const projects = [...catalog.projects, projectIdentityDigest].sort();
      const updated = sealRecord(key, AUTH_DOMAINS.replayCatalog, {
        domain: AUTH_DOMAINS.replayCatalog,
        schema: 'noosphere.replay-catalog',
        version: 1,
        projects,
        keyId: replayKeyId(key),
      });
      await writeAuthenticated(
        path.join(replayRootPath(env), 'catalog.json'),
        updated,
        env,
      );
    }
    return Object.freeze({ key, paths });
  } catch (error) {
    operationFailure = error;
    throw error;
  } finally {
    await releaseHeldLocks([catalogLock], operationFailure);
  }
}

export async function readReplayManifest({
  env = process.env,
  key,
  projectIdentityDigest,
}) {
  const paths = replayProjectPaths({ env, projectIdentityDigest });
  const raw = await readRequired(
    paths.manifest,
    REPLAY_METADATA_BYTES,
    'replay-manifest-missing',
  );
  return parseReplayManifest(raw, {
    key,
    expectedProjectIdentityDigest: projectIdentityDigest,
    expectedKeyId: replayKeyId(key),
  });
}

export async function readReplayRecord({
  env = process.env,
  key,
  projectIdentityDigest,
  replayIdentity,
}) {
  const paths = replayProjectPaths({ env, projectIdentityDigest });
  const file = path.join(paths.records, `${digestSegment(replayIdentity)}.json`);
  const raw = await readBoundedRegularFile(file, {
    maxBytes: REPLAY_RECORD_BYTES,
  });
  if (raw === null) return null;
  return parseReplayRecord(raw, {
    key,
    expectedProjectIdentityDigest: projectIdentityDigest,
    expectedReplayIdentity: replayIdentity,
    expectedKeyId: replayKeyId(key),
  });
}

export async function listReplayRecords({
  env = process.env,
  key,
  projectIdentityDigest,
}) {
  const paths = replayProjectPaths({ env, projectIdentityDigest });
  const records = [];
  for (const name of (await fs.readdir(paths.records)).sort()) {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) {
      throw storeError('replay-record-entry-invalid', 'unsafe replay record entry');
    }
    records.push(await readReplayRecord({
      env,
      key,
      projectIdentityDigest,
      replayIdentity: `sha256:${name.slice(0, -5)}`,
    }));
  }
  return Object.freeze(records);
}

export async function commitReplayRecord({
  env = process.env,
  key,
  projectIdentityDigest,
  record,
}) {
  await writeReplayRecord({ env, projectIdentityDigest, record });
  const manifest = await buildNextReplayManifest({
    env,
    key,
    projectIdentityDigest,
    record,
  });
  await writeReplayManifest({ env, projectIdentityDigest, manifest });
  return manifest;
}

export async function buildNextReplayManifest({
  env = process.env,
  key,
  projectIdentityDigest,
  record,
}) {
  const paths = replayProjectPaths({ env, projectIdentityDigest });
  const entries = [];
  let included = false;
  for (const name of (await fs.readdir(paths.records)).sort()) {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) {
      throw storeError('replay-record-entry-invalid', 'unsafe replay record entry');
    }
    const identity = `sha256:${name.slice(0, -5)}`;
    const current = identity === record.replayIdentity
      ? record
      : await readReplayRecord({
        env,
        key,
        projectIdentityDigest,
        replayIdentity: identity,
      });
    if (identity === record.replayIdentity) included = true;
    entries.push([
      current.replayIdentity,
      current.recordGeneration,
      current.mac,
    ]);
  }
  if (!included) {
    entries.push([
      record.replayIdentity,
      record.recordGeneration,
      record.mac,
    ]);
    entries.sort((left, right) => left[0].localeCompare(right[0]));
  }
  const prior = await readReplayManifest({
    env,
    key,
    projectIdentityDigest,
  });
  const manifest = sealRecord(key, AUTH_DOMAINS.replayManifest, {
    ...prior,
    recordCount: entries.length,
    recordIndexDigest: sha256(Buffer.from(canonicalize(entries), 'utf8')),
    mac: undefined,
  });
  return manifest;
}
