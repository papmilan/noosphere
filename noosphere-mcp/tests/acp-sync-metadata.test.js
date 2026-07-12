import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { promisify } from 'node:util';
import {
  consumeConfirmation,
  digestRepositoryObservation,
  issueConfirmation,
  quarantineBytes,
  readSyncMetadata,
  writeSyncMetadata,
} from '../continuity/acp/sync-metadata.js';

const dirs = [];
const execFileAsync = promisify(execFile);
const SYNC_MODULE = new URL('../continuity/acp/sync-metadata.js', import.meta.url).href;
const QUARANTINE_WRITER = new URL('../continuity/acp/quarantine-writer.js', import.meta.url);
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

  it('strictly rejects incomplete, extra, malformed, or unsupported observations before persistence', async () => {
    const mutations = [
      (value) => { delete value.remote_snapshot_id; },
      (value) => { value.extra = true; },
      (value) => { value.local_snapshot_id = 'bad'; },
      (value) => { value.remote_heads_digest = 'bad'; },
      (value) => { value.repository_observation.root_identity = 'bad'; },
      (value) => { value.repository_observation.extra = true; },
      (value) => { value.relayer_index_id = 'bad'; },
      (value) => { value.sync_protocol_version = 'other'; },
      (value) => { value.reconciliation_policy_version = 'other'; },
      (value) => { value.action = 'already-synced'; },
      (value) => { value.allow_stale_advanced = 'yes'; },
      (value) => { value.remote_expires_at = 'tomorrow'; },
    ];
    for (const mutate of mutations) {
      const root = await temp();
      const value = observation();
      mutate(value);
      await assert.rejects(issueConfirmation(root, value, NOW), /confirmation-schema/);
      assert.equal(Object.keys((await readSyncMetadata(root)).confirmations).length, 0);
    }
  });

  it('serializes concurrent issuers at the live-entry limit and recovers a dead-owner lock', async () => {
    const root = await temp();
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, number) => issueConfirmation(root, observation(number), NOW)));
    assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 16);
    assert.equal(results.filter(({ status, reason }) => status === 'rejected' && /confirmation-limit/.test(reason.message)).length, 4);
    assert.equal(Object.keys((await readSyncMetadata(root)).confirmations).length, 16);

    const staleRoot = await temp();
    await mkdir(path.join(staleRoot, '.noosphere'), { recursive: true });
    await writeFile(path.join(staleRoot, '.noosphere', 'continuity-sync.lock'), JSON.stringify({ pid: 99999999, token: 'dead', created_at: 0 }), { mode: 0o600 });
    assert.ok(await issueConfirmation(staleRoot, observation(), NOW));
  });

  it('prevents lost updates across concurrent Node processes', async () => {
    const root = await temp();
    const script = `
      const [root, start, moduleUrl] = process.argv.slice(1);
      const { issueConfirmation } = await import(moduleUrl);
      const id = (c) => 'sha256:' + c.repeat(64);
      for (let offset = 0; offset < 8; offset += 1) {
        const n = Number(start) + offset;
        await issueConfirmation(root, {
          remote_snapshot_id: 'sha256:' + n.toString(16).padStart(64, '0'),
          local_snapshot_id: null, remote_heads_digest: id('a'),
          repository_observation: { root_identity: id('b'), head: 'abc', branch: 'main', dirty: false, workspace_fingerprint: id('c'), ancestors: ['abc'] },
          relayer_index_id: id('d'), sync_protocol_version: 'noosphere.acp-sync/1',
          reconciliation_policy_version: 'noosphere.acp-reconcile/1', action: 'remote-only-restore',
          allow_stale_advanced: false, remote_expires_at: null,
        }, ${NOW});
      }
    `;
    await Promise.all([
      execFileAsync('node', ['--input-type=module', '-e', script, root, '0', SYNC_MODULE]),
      execFileAsync('node', ['--input-type=module', '-e', script, root, '8', SYNC_MODULE]),
    ]);
    assert.equal(Object.keys((await readSyncMetadata(root)).confirmations).length, 16);
  });

  it('never reclaims an old lock owned by a live PID', async () => {
    const root = await temp();
    await mkdir(path.join(root, '.noosphere'), { recursive: true });
    const lock = path.join(root, '.noosphere', 'continuity-sync.lock');
    await writeFile(lock, JSON.stringify({ pid: process.pid, token: 'live', created_at: 0 }), { mode: 0o600 });
    const started = Date.now();
    setTimeout(() => { void rm(lock, { force: true }); }, 100);
    await issueConfirmation(root, observation(), NOW);
    assert.equal(Date.now() - started >= 80, true);
  });
});

describe('ACP quarantine', () => {
  it('changes permissions only through the already-open file descriptor', async () => {
    const source = await readFile(QUARANTINE_WRITER, 'utf8');
    assert.match(source, /handle\.chmod\(0o600\)/);
    assert.doesNotMatch(source, /chmod\(filename/);
  });

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

    const swapRoot = await temp();
    await assert.rejects(quarantineBytes(swapRoot, id('d'), bytes, {
      beforeSpawn: async (directory) => {
        await rename(directory, `${directory}.old`);
        await mkdir(directory, { mode: 0o700 });
      },
    }), /quarantine-directory-mismatch/);
  });
});
