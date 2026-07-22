import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { executionPaths, readExecutionState, writeExecutionState } from '../continuity/acp/execution-store.js';
import { EXECUTION_PROTOCOL } from '../continuity/acp/execution-state.js';
import { buildInitialState, statePaths, writeState } from '../continuity/acp/store.js';
import { quarantineBytes, writeSyncMetadata } from '../continuity/acp/sync-metadata.js';
import { migrateEnvironmentFile } from '../continuity/credentials-cli.js';
import { updateRuntimeState, cspPaths } from '../continuity/csp/storage.js';
import { approveOrigin, approvedOriginsPath } from '../continuity/relayer-authority.js';
import { currentWindowsSid, verifyOwnerOnlyWindows } from '../continuity/secure-fs.js';

const isWindows = process.platform === 'win32';
const skip = isWindows ? false : 'Windows-only exact SID ACL coverage';
const SYSTEM_SID = 'S-1-5-18';
const ADMINISTRATORS_SID = 'S-1-5-32-544';
const INTERACTIVE_SID = 'S-1-5-4';
const CLOCK = '2026-07-22T12:00:00.000Z';

function temporary(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function repository(prefix) {
  const root = temporary(prefix);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'initial'], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Security Test',
      GIT_AUTHOR_EMAIL: 'security@example.com',
      GIT_COMMITTER_NAME: 'Security Test',
      GIT_COMMITTER_EMAIL: 'security@example.com',
    },
  });
  return root;
}

function assertExactAcl(file) {
  assert.deepEqual(
    verifyOwnerOnlyWindows(file).sort(),
    [currentWindowsSid(), SYSTEM_SID, ADMINISTRATORS_SID].sort(),
  );
}

function grantInteractive(file) {
  execFileSync('icacls', [file, '/grant', `*${INTERACTIVE_SID}:(R)`], { stdio: 'pipe' });
}

function executionEnvelope() {
  return {
    protocol: EXECUTION_PROTOCOL,
    project_snapshot_id: `sha256:${'a'.repeat(64)}`,
    created_at: CLOCK,
    expires_at: '2026-07-29T12:00:00.000Z',
    origin: { agent_id: 'codex', client: 'codex', session_id: null },
    repository: {
      project_id: 'security-test', head: 'b'.repeat(40), branch: 'main', dirty: false,
      workspace_fingerprint: `sha256:${'c'.repeat(64)}`,
    },
    cursor: {
      step_id: 'secure-write', status: 'before-edit', opened_files: [],
      target: { file: 'README.md', symbol: null, purpose: 'Verify ACL persistence.' },
    },
    steps: [{
      id: 'secure-write', parent_step_id: null, kind: 'edit', status: 'current',
      target: { file: 'README.md', symbol: null, content_hash: null },
      goal: 'Verify ACL persistence.',
      verify: { command: 'npm test', expectation: 'pass' },
    }],
    frontier: { searched: [], ruled_out: [] },
    validation: { last_command: null, last_result: null, failing_tests: [] },
    working_notes: [],
    integrity: {
      algorithm: 'sha256', digest: '0'.repeat(64),
      signature: { status: 'unsigned', algorithm: null, key_id: null, value: null },
    },
  };
}

test('WINDOWS ACL: MCP ACP, execution, sync, and CSP writes use the exact SID DACL', { skip }, async () => {
  const root = repository('mcp-windows-acl-');
  const initial = await buildInitialState(root, { clock: CLOCK });
  assert.equal(initial.ok, true);
  await writeState(root, initial.state, { clock: CLOCK });
  await writeExecutionState(root, executionEnvelope(), { now: CLOCK });
  await writeSyncMetadata(root, { version: 1, confirmations: {} });
  await updateRuntimeState(root, () => ({ last_checkpoint_at: CLOCK }));
  const quarantine = await quarantineBytes(root, `sha256:${'d'.repeat(64)}`, Buffer.from('remote-state'));

  for (const file of [
    statePaths(root).json,
    statePaths(root).markdown,
    executionPaths(root).json,
    path.join(root, '.noosphere', 'continuity-sync.json'),
    cspPaths(root).runtime,
    quarantine.path,
  ]) assertExactAcl(file);
});

test('WINDOWS ACL: MCP repairs a legacy execution file before parsing it', { skip }, async () => {
  const root = repository('mcp-windows-repair-');
  const file = executionPaths(root).json;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ malformed');
  grantInteractive(file);
  const result = await readExecutionState(root);
  assert.equal(result.ok, false);
  assertExactAcl(file);
});

test('WINDOWS ACL: credential migration and relayer authority state use exact SID DACLs', { skip }, async () => {
  const home = temporary('mcp-windows-credentials-');
  const envPath = path.join(home, '.env');
  fs.writeFileSync(envPath, [
    'PORT=3001',
    `MEMWAL_PRIVATE_KEY=${'a'.repeat(64)}`,
    `MEMWAL_ACCOUNT_ID=0x${'b'.repeat(64)}`,
    'MEMWAL_NETWORK=testnet',
    '',
  ].join('\n'));
  grantInteractive(envPath);
  let stored;
  await migrateEnvironmentFile({
    setPassword(value) { stored = value; },
    getPassword() { return stored; },
  }, { envPath, validator: async () => ({ valid: true }) });
  assertExactAcl(envPath);

  const env = { NOOSPHERE_HOME: path.join(home, '.noosphere') };
  await approveOrigin('https://relay.example.com', env);
  assertExactAcl(approvedOriginsPath(env));
});
