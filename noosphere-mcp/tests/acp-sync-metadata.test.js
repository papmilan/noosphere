import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  consumeConfirmation,
  digestRepositoryObservation,
  issueConfirmation,
  quarantineBytes,
  readSyncMetadata,
  writeSyncMetadata,
} from '../continuity/acp/sync-metadata.js';

const dirs = [];
async function temp() { const root = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(path.join(os.tmpdir(), 'noosphere-sync-meta-'))); dirs.push(root); return root; }
after(async () => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));
const id = (char) => `sha256:${char.repeat(64)}`;
const NOW = Date.parse('2026-07-13T00:00:00.000Z');

function observation(number = 0, overrides = {}) {
  return {
    remote_snapshot_id: `sha256:${number.toString(16).padStart(64, '0')}`,
    local_snapshot_id: null,
    remote_heads_digest: id('a'),
    repository_observation: { root_identity: id('b'), head: 'abc', branch: 'main', dirty: false, workspace_fingerprint: id('c'), ancestors: ['z', 'a'] },
    relayer_index_id: id('d'),
    sync_protocol_version: 'noosphere.acp-sync/1',
    reconciliation_policy_version: 'noosphere.acp-reconcile/1',
    action: 'remote-only-restore',
    allow_stale_advanced: false,
    remote_expires_at: null,
    ...overrides,
  };
}

describe('ACP sync metadata confirmations', () => {
  it('writes owner-only atomic metadata and canonicalizes the complete repository observation', async () => {
    const root = await temp();
    await writeSyncMetadata(root, { version: 1, confirmations: {}, remote_heads: [id('a')] });
    const file = path.join(root, '.noosphere', 'continuity-sync.json');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
    assert.deepEqual((await readSyncMetadata(root)).remote_heads, [id('a')]);
    assert.equal(digestRepositoryObservation(observation().repository_observation), digestRepositoryObservation({ ...observation().repository_observation, ancestors: ['a', 'z'] }));
  });

  it('persists a bounded single-use confirmation and deletes it before later validation', async () => {
    const root = await temp();
    const issued = await issueConfirmation(root, observation(), NOW);
    assert.match(issued.confirmation_id, /^sha256:[0-9a-f]{64}$/);
    assert.equal((await readSyncMetadata(root)).confirmations[issued.confirmation_id].remote_snapshot_id, observation().remote_snapshot_id);
    assert.equal((await consumeConfirmation(root, issued.confirmation_id, NOW)).confirmation_id, issued.confirmation_id);
    await assert.rejects(consumeConfirmation(root, issued.confirmation_id, NOW), /confirmation-missing/);

    const tampered = await issueConfirmation(root, observation(1), NOW);
    const metadata = await readSyncMetadata(root);
    metadata.confirmations[tampered.confirmation_id].action = 'tampered';
    await writeSyncMetadata(root, metadata);
    await assert.rejects(consumeConfirmation(root, tampered.confirmation_id, NOW), /confirmation-invalid/);
    await assert.rejects(consumeConfirmation(root, tampered.confirmation_id, NOW), /confirmation-missing/);
  });

  it('caps live confirmations at 16 without eviction and bounds expiry by five minutes and remote expiry', async () => {
    const root = await temp();
    for (let number = 0; number < 16; number += 1) await issueConfirmation(root, observation(number), NOW);
    await assert.rejects(issueConfirmation(root, observation(16), NOW), /confirmation-limit/);
    assert.equal(Object.keys((await readSyncMetadata(root)).confirmations).length, 16);
    const other = await temp();
    const remoteExpiry = new Date(NOW + 60_000).toISOString();
    const issued = await issueConfirmation(other, observation(20, { remote_expires_at: remoteExpiry }), NOW);
    assert.equal(issued.expires_at, remoteExpiry);
  });
});

describe('ACP quarantine', () => {
  it('uses only safe names, exclusive owner-only files, and rejects symlink directories or targets', async () => {
    const root = await temp();
    const bytes = Buffer.from('untrusted remote bytes');
    const hostile = await quarantineBytes(root, '../../secret', bytes);
    assert.match(path.basename(hostile.path), /^sha256-[0-9a-f]{64}\.json$/);
    assert.equal((await stat(hostile.path)).mode & 0o777, 0o600);
    assert.deepEqual(await readFile(hostile.path), bytes);
    await assert.rejects(quarantineBytes(root, '../../secret', bytes), /quarantine-exists/);

    const targetRoot = await temp();
    await mkdir(path.join(targetRoot, '.noosphere', 'quarantine'), { recursive: true });
    const target = path.join(targetRoot, '.noosphere', 'quarantine', `sha256-${'a'.repeat(64)}.json`);
    await symlink(path.join(targetRoot, 'elsewhere'), target);
    await assert.rejects(quarantineBytes(targetRoot, id('a'), bytes), /quarantine-symlink/);

    const dirRoot = await temp();
    await mkdir(path.join(dirRoot, '.noosphere'), { recursive: true });
    await symlink(targetRoot, path.join(dirRoot, '.noosphere', 'quarantine'));
    await assert.rejects(quarantineBytes(dirRoot, id('b'), bytes), /quarantine-symlink/);
    assert.equal((await lstat(path.join(dirRoot, '.noosphere', 'quarantine'))).isSymbolicLink(), true);

    const parentRoot = await temp();
    await symlink(path.join(targetRoot, '.noosphere'), path.join(parentRoot, '.noosphere'));
    await assert.rejects(quarantineBytes(parentRoot, id('c'), bytes), /quarantine-symlink/);
  });
});
