// Node probe used by verify-secure-fs-windows.ps1. Exercises one SEC-03 store
// operation against a state directory that the PowerShell harness has already
// turned into a symlink or junction pointing outside the project. Reports, as a
// single JSON line, whether the operation was refused and — the real safety
// invariant — whether anything was written or chmod'd outside the intended root.
//
// Usage: node secure-fs-windows-probe.mjs <scenario> <root> <outside> <repoRoot>
//   scenario: project-state | execution-state | credential
// Exit code 0 = safe (no outside mutation), 1 = unsafe.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readdir, stat } from 'node:fs/promises';

const [, , scenario, root, outside, repoRoot] = process.argv;
const load = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);

function isBoundaryError(error) {
  if (!error) return false;
  if (error.name === 'PathBoundaryError') return true;
  return [
    'state-dir-symlink',
    'state-dir-escape',
    'state-dir-not-directory',
    'state-file-symlink',
  ].includes(error.code);
}

async function snapshot(dir) {
  const files = await readdir(dir).catch(() => []);
  const mode = ((await stat(dir).catch(() => ({ mode: 0 }))).mode) & 0o777;
  return { files: files.sort(), mode };
}

function executionEnvelope(clock, executionProtocol) {
  return {
    protocol: executionProtocol,
    project_snapshot_id: `sha256:${'a'.repeat(64)}`,
    created_at: clock,
    expires_at: '2026-07-19T00:00:00.000Z',
    origin: { agent_id: 'claude', client: 'claude-code', session_id: null },
    repository: {
      project_id: 'noosphere', head: 'b'.repeat(40), branch: 'main', dirty: false,
      workspace_fingerprint: `sha256:${'c'.repeat(64)}`,
    },
    cursor: { step_id: 's1', status: 'before-edit', opened_files: [], target: { file: 'a.js', symbol: null, purpose: 'Do the thing.' } },
    steps: [{
      id: 's1', parent_step_id: null, kind: 'edit', status: 'current',
      target: { file: 'a.js', symbol: null, content_hash: null },
      goal: 'Do the thing.', verify: { command: 'node --test t', expectation: 'pass' },
    }],
    frontier: { searched: [], ruled_out: [] },
    validation: { last_command: null, last_result: null, failing_tests: [] },
    working_notes: [],
    integrity: { algorithm: 'sha256', digest: '0'.repeat(64), signature: { status: 'unsigned', algorithm: null, key_id: null, value: null } },
  };
}

const CLOCK = '2026-07-12T00:00:00.000Z';
const before = await snapshot(outside);
let refused = false;
let error = null;

try {
  if (scenario === 'project-state') {
    const { buildInitialState, writeState } = await load('noosphere-mcp/continuity/acp/store.js');
    const init = await buildInitialState(root, { clock: CLOCK });
    await writeState(root, init.state, { clock: CLOCK });
  } else if (scenario === 'execution-state') {
    const { writeExecutionState } = await load('noosphere-mcp/continuity/acp/execution-store.js');
    const { EXECUTION_PROTOCOL } = await load('noosphere-mcp/continuity/acp/execution-state.js');
    await writeExecutionState(root, executionEnvelope(CLOCK, EXECUTION_PROTOCOL), { now: CLOCK });
  } else if (scenario === 'credential') {
    const { CredentialStore } = await load('noosphere-relayer/credentials.js');
    // Force the owner-only file fallback (native backend "fails") so the
    // no-follow/containment path is exercised. home = root, so ~/.noosphere is
    // the attacker-controlled reparse point.
    const store = new CredentialStore('default', { platform: 'linux', home: root, run: () => ({ status: 1 }) });
    store.setPassword('SENTINEL-SECRET-DO-NOT-LEAK');
  } else {
    throw new Error(`unknown scenario: ${scenario}`);
  }
} catch (caught) {
  refused = true;
  error = caught;
}

const after = await snapshot(outside);
const newOutside = after.files.filter((f) => !before.files.includes(f));
const noNewOutside = newOutside.length === 0;
const modeUnchanged = after.mode === before.mode;
const safe = noNewOutside && modeUnchanged;

console.log(JSON.stringify({
  scenario,
  refused,
  boundaryError: isBoundaryError(error),
  code: error?.code ?? error?.name ?? null,
  safe,
  noNewOutside,
  modeUnchanged,
  newOutsideCount: newOutside.length,
}));

process.exit(safe ? 0 : 1);
