import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { promisify } from 'node:util';

import { buildInitialState, readState, statePaths, writeState } from '../continuity/acp/store.js';
import { executionPaths, readExecutionState } from '../continuity/acp/execution-store.js';
import { readSyncMetadata, writeSyncMetadata } from '../continuity/acp/sync-metadata.js';

const execFileAsync = promisify(execFile);
const directories = [];

async function repository(prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  directories.push(root);
  await execFileAsync('git', ['init'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'security@example.com'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'Security Test'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# secure\n');
  await writeFile(path.join(root, '.gitignore'), '.noosphere/\n');
  await execFileAsync('git', ['add', '.'], { cwd: root });
  await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
  return root;
}

function boundary(events, { fail = false } = {}) {
  return {
    platform: 'win32',
    windowsAction({ action, file, input }) {
      events.push({ action, file, before: fs.existsSync(file) ? fs.statSync(file).size : null });
      if (fail) throw Object.assign(new Error('forced ACL failure'), { code: 'state-acl-failed' });
      if (action === 'write') {
        const fd = fs.openSync(file, 'wx', 0o600);
        try {
          assert.equal(fs.fstatSync(fd).size, 0);
          fs.writeFileSync(fd, input);
        } finally { fs.closeSync(fd); }
        return Buffer.alloc(0);
      }
      if (action === 'read') return fs.readFileSync(file);
      throw new Error(`unexpected ${action}`);
    },
  };
}

after(async () => Promise.all(directories.map((dir) => rm(dir, { recursive: true, force: true }))));

describe('MCP shared owner-only persistence boundary', () => {
  test('ACP state writes securely before content and repairs before reading', async () => {
    const root = await repository('mcp-owner-state-');
    const initial = await buildInitialState(root, { clock: '2026-07-22T12:00:00.000Z' });
    assert.equal(initial.ok, true);
    const events = [];
    const secureFileOptions = boundary(events);

    await writeState(root, initial.state, {
      clock: '2026-07-22T12:00:00.000Z',
      secureFileOptions,
    });
    const read = await readState(root, {
      clock: '2026-07-22T12:00:00.000Z',
      secureFileOptions,
    });
    assert.equal(read.ok, true);
    assert.ok(events.filter(({ action }) => action === 'write').length >= 2);
    assert.ok(events.some(({ action }) => action === 'read'));
    assert.ok(events.filter(({ action }) => action === 'write').every(({ before }) => before === null));
  });

  test('ACP ACL failure leaves no sensitive target or temporary file', async () => {
    const root = await repository('mcp-owner-state-fail-');
    const initial = await buildInitialState(root, { clock: '2026-07-22T12:00:00.000Z' });
    await assert.rejects(
      writeState(root, initial.state, {
        clock: '2026-07-22T12:00:00.000Z',
        secureFileOptions: boundary([], { fail: true }),
      }),
      (error) => error.code === 'state-acl-failed',
    );
    const { dir, json, markdown } = statePaths(root);
    assert.equal(fs.existsSync(json), false);
    assert.equal(fs.existsSync(markdown), false);
    assert.deepEqual((await fs.promises.readdir(dir)).filter((name) => name.includes('.tmp')), []);
  });

  test('execution state is repaired before malformed legacy content is parsed', async () => {
    const root = await repository('mcp-owner-execution-');
    const paths = executionPaths(root);
    await mkdir(paths.dir, { recursive: true });
    await writeFile(paths.json, '{ malformed');
    const events = [];
    const result = await readExecutionState(root, { secureFileOptions: boundary(events) });
    assert.equal(result.ok, false);
    assert.equal(events[0].action, 'read');
  });

  test('sync metadata uses secure write and repair-before-read', async () => {
    const root = await repository('mcp-owner-sync-');
    const events = [];
    const secureFileOptions = boundary(events);
    await writeSyncMetadata(root, { version: 1, confirmations: {} }, { secureFileOptions });
    await readSyncMetadata(root, { secureFileOptions });
    assert.ok(events.some(({ action }) => action === 'write'));
    assert.ok(events.some(({ action }) => action === 'read'));
  });
});
