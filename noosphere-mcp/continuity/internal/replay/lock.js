import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  acquireOwnerOnlyLock,
  ensureRealDirectoryPath,
  inspectOwnerOnlyDestination,
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
  verifyRecord,
} from '../authenticated-records.js';
import {
  REPLAY_METADATA_BYTES,
} from './constants.js';
import {
  replayKeyId,
  replayRootPath,
} from './key.js';
import {
  LOCK_RANKS,
  acquireRankedLock,
} from './lock-ranks.js';

const SHA256_ID = /^sha256:[0-9a-f]{64}$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REPLAY_LOCK_FIELDS = new Set([
  'domain',
  'keyId',
  'lockType',
  'mac',
  'projectIdentityDigest',
  'replayIdentity',
  'schema',
  'token',
  'version',
]);

function lockError(code, message, cause) {
  const error = new TrustStoreError(code, message);
  if (cause !== undefined) error.cause = cause;
  return error;
}

function digestPathSegment(value) {
  if (!SHA256_ID.test(value)) {
    throw lockError('replay-lock-identity-invalid', 'replay lock identity is invalid');
  }
  return value.slice('sha256:'.length);
}

function validateReplayLock(record, expected) {
  return record &&
    typeof record === 'object' &&
    !Array.isArray(record) &&
    Object.keys(record).length === REPLAY_LOCK_FIELDS.size &&
    Object.keys(record).every(field => REPLAY_LOCK_FIELDS.has(field)) &&
    record.domain === AUTH_DOMAINS.replayLock &&
    record.schema === 'noosphere.replay-lock' &&
    record.version === 1 &&
    record.lockType === expected.lockType &&
    record.projectIdentityDigest === expected.projectIdentityDigest &&
    record.replayIdentity === expected.replayIdentity &&
    record.keyId === expected.keyId &&
    record.token === expected.token &&
    UUID_V4.test(record.token) &&
    typeof record.mac === 'string' &&
    /^[0-9a-f]{64}$/.test(record.mac);
}

async function verifyLockBeforeRelease({
  file,
  authKey,
  domain,
  expected,
  validate,
  malformedCode,
  secureFileOptions,
}) {
  await inspectOwnerOnlyDestination(file, {
    ...secureFileOptions,
    maxBytes: REPLAY_METADATA_BYTES,
  });
  const raw = await readBoundedRegularFile(file, {
    maxBytes: REPLAY_METADATA_BYTES,
  });
  if (raw === null) {
    throw lockError(malformedCode, 'lock disappeared before release');
  }
  let record;
  try {
    const text = raw.toString('utf8');
    record = JSON.parse(text);
    if (text !== canonicalize(record)) throw new Error('noncanonical lock');
  } catch (cause) {
    throw lockError(malformedCode, 'lock metadata is malformed', cause);
  }
  if (
    !validate(record, expected) ||
    !verifyRecord(authKey, domain, record)
  ) {
    throw lockError(malformedCode, 'lock authentication failed');
  }
}

export async function acquireAuthenticatedRankedFileLock({
  scope,
  rank,
  lockKey,
  file,
  authKey,
  domain,
  fields,
  validate,
  busyCode,
  malformedCode,
  secureFileOptions = {},
}) {
  const token = randomUUID();
  const expectedFields = Object.freeze({
    ...fields,
    token,
  });
  const sealed = sealRecord(authKey, domain, expectedFields);
  const canonicalMetadata = JSON.parse(canonicalize(sealed));
  const ranked = await acquireRankedLock(scope, {
    rank,
    key: lockKey,
    acquire: async () => {
      await ensureRealDirectoryPath(path.dirname(file));
      await inspectOwnerOnlyDestination(file, {
        ...secureFileOptions,
        maxBytes: REPLAY_METADATA_BYTES,
      });
      let filesystemLock;
      try {
        filesystemLock = await acquireOwnerOnlyLock(file, {
          ...secureFileOptions,
          token,
          metadata: canonicalMetadata,
        });
      } catch (cause) {
        if (cause.code === 'trust-lock-busy') {
          throw lockError(busyCode, 'authenticated lock is already held', cause);
        }
        throw cause;
      }
      return {
        release: async () => {
          await verifyLockBeforeRelease({
            file,
            authKey,
            domain,
            expected: expectedFields,
            validate,
            malformedCode,
            secureFileOptions,
          });
          await filesystemLock.release(token);
        },
      };
    },
  });
  return Object.freeze({
    file,
    key: ranked.key,
    rank: ranked.rank,
    token,
    release: ranked.release,
  });
}

function replayLockFields({
  key,
  lockType,
  projectIdentityDigest,
  replayIdentity,
}) {
  return {
    domain: AUTH_DOMAINS.replayLock,
    schema: 'noosphere.replay-lock',
    version: 1,
    lockType,
    projectIdentityDigest,
    replayIdentity,
    keyId: replayKeyId(key),
  };
}

async function acquireReplayLock({
  scope,
  env,
  key,
  rank,
  lockKey,
  file,
  fields,
  secureFileOptions,
}) {
  return acquireAuthenticatedRankedFileLock({
    scope,
    rank,
    lockKey,
    file,
    authKey: key,
    domain: AUTH_DOMAINS.replayLock,
    fields,
    validate: validateReplayLock,
    busyCode: 'replay-lock-busy',
    malformedCode: 'replay-lock-malformed',
    secureFileOptions: {
      ...secureFileOptions,
      root: homeDir(env),
    },
  });
}

export async function acquireReplayCatalogLock({
  scope,
  env = process.env,
  key,
  secureFileOptions = {},
}) {
  return acquireReplayLock({
    scope,
    env,
    key,
    rank: LOCK_RANKS.replayCatalog,
    lockKey: 'replay-catalog',
    file: path.join(replayRootPath(env), 'catalog.lock'),
    fields: replayLockFields({
      key,
      lockType: 'catalog',
      projectIdentityDigest: null,
      replayIdentity: null,
    }),
    secureFileOptions,
  });
}

export async function acquireReplayProjectLock({
  scope,
  env = process.env,
  key,
  projectIdentityDigest,
  secureFileOptions = {},
}) {
  const projectSegment = digestPathSegment(projectIdentityDigest);
  return acquireReplayLock({
    scope,
    env,
    key,
    rank: LOCK_RANKS.replayProject,
    lockKey: `replay-project:${projectIdentityDigest}`,
    file: path.join(
      replayRootPath(env),
      'projects',
      projectSegment,
      'ledger.lock',
    ),
    fields: replayLockFields({
      key,
      lockType: 'project',
      projectIdentityDigest,
      replayIdentity: null,
    }),
    secureFileOptions,
  });
}

export async function acquireReplayIdentityLock({
  scope,
  env = process.env,
  key,
  projectIdentityDigest,
  replayIdentity,
  secureFileOptions = {},
}) {
  const projectSegment = digestPathSegment(projectIdentityDigest);
  const replaySegment = digestPathSegment(replayIdentity);
  return acquireReplayLock({
    scope,
    env,
    key,
    rank: LOCK_RANKS.replayIdentity,
    lockKey:
      `replay-identity:${projectIdentityDigest}:${replayIdentity}`,
    file: path.join(
      replayRootPath(env),
      'projects',
      projectSegment,
      'locks',
      `${replaySegment}.lock`,
    ),
    fields: replayLockFields({
      key,
      lockType: 'identity',
      projectIdentityDigest,
      replayIdentity,
    }),
    secureFileOptions,
  });
}
