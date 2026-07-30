import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import {
  AUTH_DOMAINS,
  verifyRecord,
} from '../continuity/internal/authenticated-records.js';
import { ensureReplayKey } from '../continuity/internal/replay/key.js';
import { canonicalize } from '../continuity/trust-store-internal.js';

const ranksModule = await import(
  '../continuity/internal/replay/lock-ranks.js'
).catch(() => null);
const replayLockModule = await import(
  '../continuity/internal/replay/lock.js'
).catch(() => null);
const candidateLockModule = await import(
  '../continuity/internal/restore/candidate-index-lock.js'
).catch(() => null);

const PROJECT = `sha256:${'a'.repeat(64)}`;
const REPLAY_A = `sha256:${'b'.repeat(64)}`;
const REPLAY_B = `sha256:${'c'.repeat(64)}`;
const PAYLOAD = 'd'.repeat(64);
const temporary = [];

after(async () => {
  await Promise.all(temporary.map(directory =>
    fs.rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporary.push(directory);
  return directory;
}

test('ranked scope enforces ascending ranks, lexical peers, and reverse release', async () => {
  assert.ok(ranksModule, 'production lock-rank module must exist');
  const {
    LOCK_RANKS,
    acquireRankedLock,
    createRankedLockScope,
  } = ranksModule;
  const scope = createRankedLockScope();
  const released = [];
  const project = await acquireRankedLock(scope, {
    rank: LOCK_RANKS.replayProject,
    key: `replay-project:${PROJECT}`,
    acquire: async () => ({
      release: async () => released.push('project'),
    }),
  });
  const identityA = await acquireRankedLock(scope, {
    rank: LOCK_RANKS.replayIdentity,
    key: `replay-identity:${PROJECT}:${REPLAY_A}`,
    acquire: async () => ({
      release: async () => released.push('identity-a'),
    }),
  });
  const identityB = await acquireRankedLock(scope, {
    rank: LOCK_RANKS.replayIdentity,
    key: `replay-identity:${PROJECT}:${REPLAY_B}`,
    acquire: async () => ({
      release: async () => released.push('identity-b'),
    }),
  });

  let lowerAcquireCalled = false;
  await assert.rejects(
    acquireRankedLock(scope, {
      rank: LOCK_RANKS.replayProject,
      key: `replay-project:${PROJECT}`,
      acquire: async () => {
        lowerAcquireCalled = true;
        return { release: async () => undefined };
      },
    }),
    error => error.code === 'lock-rank-order-invalid',
  );
  assert.equal(lowerAcquireCalled, false);
  await assert.rejects(
    project.release(),
    error => error.code === 'lock-release-order-invalid',
  );

  await identityB.release();
  await identityA.release();
  await project.release();
  assert.deepEqual(released, ['identity-b', 'identity-a', 'project']);
});

test('same-rank locks reject non-lexical order before acquisition', async () => {
  assert.ok(ranksModule, 'production lock-rank module must exist');
  const {
    LOCK_RANKS,
    acquireRankedLock,
    createRankedLockScope,
  } = ranksModule;
  const scope = createRankedLockScope();
  const held = await acquireRankedLock(scope, {
    rank: LOCK_RANKS.replayIdentity,
    key: 'replay-identity:z',
    acquire: async () => ({ release: async () => undefined }),
  });
  let called = false;
  await assert.rejects(
    acquireRankedLock(scope, {
      rank: LOCK_RANKS.replayIdentity,
      key: 'replay-identity:a',
      acquire: async () => {
        called = true;
        return { release: async () => undefined };
      },
    }),
    error => error.code === 'lock-rank-order-invalid',
  );
  assert.equal(called, false);
  await held.release();
});

test('rank 60 refuses to begin while any replay or restore lock is held', async () => {
  assert.ok(ranksModule, 'production lock-rank module must exist');
  const {
    LOCK_RANKS,
    acquireRankedLock,
    createRankedLockScope,
  } = ranksModule;
  const scope = createRankedLockScope();
  const held = await acquireRankedLock(scope, {
    rank: LOCK_RANKS.restoreCandidateIndex,
    key: 'restore-candidate-index:test',
    acquire: async () => ({ release: async () => undefined }),
  });
  let called = false;
  await assert.rejects(
    acquireRankedLock(scope, {
      rank: LOCK_RANKS.authorityTransaction,
      key: 'authority:test',
      acquire: async () => {
        called = true;
        return { release: async () => undefined };
      },
    }),
    error => error.code === 'lock-rank-authority-boundary',
  );
  assert.equal(called, false);
  await held.release();
});

test('adapter rank refusal happens before creating any lock directory', async () => {
  assert.ok(ranksModule, 'production lock-rank module must exist');
  assert.ok(replayLockModule, 'production replay lock module must exist');
  assert.ok(candidateLockModule, 'production candidate-index lock module must exist');
  const {
    LOCK_RANKS,
    acquireRankedLock,
    createRankedLockScope,
  } = ranksModule;
  const root = await temporaryDirectory('noosphere-lock-order-no-write-');
  const home = path.join(root, 'home');
  const candidateRoot = path.join(root, 'restore');
  await fs.mkdir(home, { mode: 0o700 });
  await fs.mkdir(candidateRoot, { mode: 0o700 });
  const env = { NOOSPHERE_HOME: home };
  const replayKey = await ensureReplayKey({ env });
  const authorityKey = randomBytes(32);

  const candidateScope = createRankedLockScope();
  const rank50 = await acquireRankedLock(candidateScope, {
    rank: LOCK_RANKS.restoreCandidateState,
    key: 'restore-candidate:z',
    acquire: async () => ({ release: async () => undefined }),
  });
  await assert.rejects(
    candidateLockModule.acquireCandidateIndexLock({
      scope: candidateScope,
      root: candidateRoot,
      key: authorityKey,
      projectIdentityDigest: PROJECT,
      slot: 'baseline',
      candidatePayloadHash: PAYLOAD,
    }),
    error => error.code === 'lock-rank-order-invalid',
  );
  assert.equal(
    await fs.stat(path.join(candidateRoot, 'candidate-index-locks'))
      .catch(() => null),
    null,
  );
  await rank50.release();

  const replayScope = createRankedLockScope();
  const rank40 = await acquireRankedLock(replayScope, {
    rank: LOCK_RANKS.restoreCandidateIndex,
    key: 'restore-candidate-index:z',
    acquire: async () => ({ release: async () => undefined }),
  });
  const foreignProject = `sha256:${'e'.repeat(64)}`;
  await assert.rejects(
    replayLockModule.acquireReplayProjectLock({
      scope: replayScope,
      env,
      key: replayKey,
      projectIdentityDigest: foreignProject,
    }),
    error => error.code === 'lock-rank-order-invalid',
  );
  assert.equal(
    await fs.stat(path.join(
      home,
      'replay-v1',
      'projects',
      foreignProject.slice(7),
    )).catch(() => null),
    null,
  );
  await rank40.release();
});

test('replay locks are canonical, authenticated, ranked, and released in reverse', async () => {
  assert.ok(replayLockModule, 'production replay lock module must exist');
  assert.ok(ranksModule, 'production lock-rank module must exist');
  const home = await temporaryDirectory('noosphere-replay-lock-home-');
  const env = { NOOSPHERE_HOME: home };
  const key = await ensureReplayKey({ env });
  const scope = ranksModule.createRankedLockScope();

  const catalog = await replayLockModule.acquireReplayCatalogLock({
    scope,
    env,
    key,
  });
  const project = await replayLockModule.acquireReplayProjectLock({
    scope,
    env,
    key,
    projectIdentityDigest: PROJECT,
  });
  const identity = await replayLockModule.acquireReplayIdentityLock({
    scope,
    env,
    key,
    projectIdentityDigest: PROJECT,
    replayIdentity: REPLAY_A,
  });

  for (const lock of [catalog, project, identity]) {
    const raw = await fs.readFile(lock.file, 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(raw, canonicalize(parsed));
    assert.equal(parsed.domain, AUTH_DOMAINS.replayLock);
    assert.equal(verifyRecord(key, AUTH_DOMAINS.replayLock, parsed), true);
    assert.equal(parsed.token, lock.token);
  }

  await assert.rejects(
    catalog.release(),
    error => error.code === 'lock-release-order-invalid',
  );
  await identity.release();
  await project.release();
  await catalog.release();
  for (const lock of [catalog, project, identity]) {
    assert.equal(await fs.stat(lock.file).catch(() => null), null);
  }
});

test('present or malformed replay lock refuses acquisition without deletion', async () => {
  assert.ok(replayLockModule, 'production replay lock module must exist');
  assert.ok(ranksModule, 'production lock-rank module must exist');
  const home = await temporaryDirectory('noosphere-replay-lock-busy-');
  const env = { NOOSPHERE_HOME: home };
  const key = await ensureReplayKey({ env });
  const firstScope = ranksModule.createRankedLockScope();
  const first = await replayLockModule.acquireReplayProjectLock({
    scope: firstScope,
    env,
    key,
    projectIdentityDigest: PROJECT,
  });
  const before = await fs.readFile(first.file);
  await assert.rejects(
    replayLockModule.acquireReplayProjectLock({
      scope: ranksModule.createRankedLockScope(),
      env,
      key,
      projectIdentityDigest: PROJECT,
    }),
    error => error.code === 'replay-lock-busy',
  );
  assert.deepEqual(await fs.readFile(first.file), before);
  await first.release();

  await fs.writeFile(first.file, 'malformed-lock', { mode: 0o600 });
  const malformed = await fs.readFile(first.file);
  await assert.rejects(
    replayLockModule.acquireReplayProjectLock({
      scope: ranksModule.createRankedLockScope(),
      env,
      key,
      projectIdentityDigest: PROJECT,
    }),
    error => error.code === 'replay-lock-busy',
  );
  assert.deepEqual(await fs.readFile(first.file), malformed);
});

test('unsafe replay and restore lock directories fail before lock creation', async t => {
  if (process.platform === 'win32') {
    t.skip('POSIX mode mutation fixture');
    return;
  }
  assert.ok(replayLockModule, 'production replay lock module must exist');
  assert.ok(candidateLockModule, 'production candidate-index lock module must exist');
  assert.ok(ranksModule, 'production lock-rank module must exist');

  const home = await temporaryDirectory('noosphere-unsafe-replay-lock-');
  const env = { NOOSPHERE_HOME: home };
  const replayKey = await ensureReplayKey({ env });
  const projectDirectory = path.join(
    home,
    'replay-v1',
    'projects',
    PROJECT.slice(7),
  );
  await fs.mkdir(projectDirectory, { recursive: true, mode: 0o700 });
  await fs.chmod(projectDirectory, 0o777);
  await assert.rejects(
    replayLockModule.acquireReplayProjectLock({
      scope: ranksModule.createRankedLockScope(),
      env,
      key: replayKey,
      projectIdentityDigest: PROJECT,
    }),
    error => error.code === 'state-dir-unsafe-mode',
  );
  assert.equal(
    await fs.stat(path.join(projectDirectory, 'ledger.lock')).catch(() => null),
    null,
  );

  const restoreRoot = await temporaryDirectory('noosphere-unsafe-restore-lock-');
  await fs.chmod(restoreRoot, 0o777);
  await assert.rejects(
    candidateLockModule.acquireCandidateIndexLock({
      scope: ranksModule.createRankedLockScope(),
      root: restoreRoot,
      key: randomBytes(32),
      projectIdentityDigest: PROJECT,
      slot: 'baseline',
      candidatePayloadHash: PAYLOAD,
    }),
    error => error.code === 'state-dir-unsafe-mode',
  );
  assert.equal(
    await fs.stat(path.join(restoreRoot, 'candidate-index-locks'))
      .catch(() => null),
    null,
  );
});

test('candidate-index lock binds only the trusted tuple in a restore-only domain', async () => {
  assert.ok(candidateLockModule, 'production candidate-index lock module must exist');
  assert.ok(ranksModule, 'production lock-rank module must exist');
  const root = await temporaryDirectory('noosphere-candidate-index-lock-');
  const key = randomBytes(32);
  const scope = ranksModule.createRankedLockScope();
  const lock = await candidateLockModule.acquireCandidateIndexLock({
    scope,
    root,
    key,
    projectIdentityDigest: PROJECT,
    slot: 'baseline',
    candidatePayloadHash: PAYLOAD,
  });
  const raw = await fs.readFile(lock.file, 'utf8');
  const parsed = JSON.parse(raw);

  assert.equal(raw, canonicalize(parsed));
  assert.equal(parsed.domain, AUTH_DOMAINS.restoreCandidateIndexLock);
  assert.equal(
    verifyRecord(key, AUTH_DOMAINS.restoreCandidateIndexLock, parsed),
    true,
  );
  assert.deepEqual(Object.keys(parsed).sort(), [
    'candidatePayloadHash',
    'domain',
    'keyId',
    'mac',
    'projectIdentityDigest',
    'schema',
    'slot',
    'token',
    'version',
  ]);
  assert.equal(raw.includes('replayIdentity'), false);
  assert.equal(raw.includes('candidateId'), false);
  await lock.release();
});

test('candidate-index lock rejects replay identity input and serializes contenders', async () => {
  assert.ok(candidateLockModule, 'production candidate-index lock module must exist');
  assert.ok(ranksModule, 'production lock-rank module must exist');
  const root = await temporaryDirectory('noosphere-candidate-index-race-');
  const key = randomBytes(32);
  const input = {
    root,
    key,
    projectIdentityDigest: PROJECT,
    slot: 'baseline',
    candidatePayloadHash: PAYLOAD,
  };
  await assert.rejects(
    candidateLockModule.acquireCandidateIndexLock({
      ...input,
      scope: ranksModule.createRankedLockScope(),
      replayIdentity: REPLAY_A,
    }),
    /exactly scope, root, key, projectIdentityDigest, slot, and candidatePayloadHash/,
  );

  const results = await Promise.allSettled([
    candidateLockModule.acquireCandidateIndexLock({
      ...input,
      scope: ranksModule.createRankedLockScope(),
    }),
    candidateLockModule.acquireCandidateIndexLock({
      ...input,
      scope: ranksModule.createRankedLockScope(),
    }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(
    results.filter(result =>
      result.status === 'rejected' &&
      result.reason.code === 'restore-candidate-index-lock-busy').length,
    1,
  );
  const winner = results.find(result => result.status === 'fulfilled').value;
  await winner.release();
});
