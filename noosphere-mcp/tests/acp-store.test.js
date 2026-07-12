import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { ACP_PROTOCOL, ACP_SCHEMA_VERSION } from '../continuity/acp/project-state.js';
import { decodeEnvelope, digestEnvelope } from '../continuity/acp/wire.js';
import { observeRepository } from '../continuity/acp/git-state.js';
import { readState, writeState } from '../continuity/acp/store.js';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../continuity/index.js', import.meta.url));
const CREATED_AT = '2026-07-12T00:00:00.000Z';
const dirs = [];

async function makeRepo() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'noosphere-acp-store-'));
  dirs.push(dir);
  await execFileAsync('git', ['init'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await writeFile(path.join(dir, 'README.md'), `# ${path.basename(dir)}\n`);
  await execFileAsync('git', ['add', '.'], { cwd: dir });
  await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: dir });
  return dir;
}

async function signedEnvelope(observed, overrides = {}) {
  const base = {
    protocol: ACP_PROTOCOL,
    schema_version: ACP_SCHEMA_VERSION,
    snapshot_id: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    parent_snapshot_id: null,
    created_at: CREATED_AT,
    expires_at: null,
    origin: { agent_id: 'codex', client: 'codex-desktop', session_id: null },
    integrity: {
      algorithm: 'sha256',
      digest: '0000000000000000000000000000000000000000000000000000000000000000',
      signature: { status: 'unsigned', algorithm: null, key_id: null, value: null },
    },
    permission_scope: 'project',
    trust: { level: 'local-unverified', reasons: ['unsigned local envelope'] },
    repository: {
      project_id: 'noosphere',
      root_identity: observed.root_identity,
      head: observed.head,
      branch: observed.branch,
      merge_base: null,
      dirty: observed.dirty,
      workspace_fingerprint: observed.workspace_fingerprint,
    },
    phase: 'implementation',
    goal: { project: 'Continuity.', current_objective: 'Persist ACP state.', success_conditions: ['State round-trips.'] },
    plan: [], completed_work: [], decisions: [], evidence: [], assumptions: [],
    rejected_approaches: [], unknowns: [], blockers: [], risks: [], conflicts: [],
    working_stance: { confidence: 'medium', momentum: 'progressing', risk_posture: 'verify-before-change', attention: [], dissatisfaction: [], successor_behavior: [] },
    next_actions: [{ id: 'n1', text: 'Wire the ACP CLI', status: 'planned', confidence: 'high', provenance: ['r1'], created_at: CREATED_AT, expires_at: null, repository_fingerprint: null, supersedes: [], priority: 1 }],
    references: [{ id: 'r1', kind: 'file', locator: 'continuity/index.js' }],
    extensions: {},
    ...overrides,
  };
  const digest = digestEnvelope(base);
  base.integrity.digest = digest;
  base.snapshot_id = `sha256:${digest}`;
  return base;
}

describe('ACP store and CLI', () => {
  let projectDir;

  before(async () => {
    projectDir = await makeRepo();
  });

  after(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('writes matching canonical JSON and Markdown', async () => {
    const observed = await observeRepository(projectDir);
    const state = decodeEnvelope(await signedEnvelope(observed), { clock: CREATED_AT }).state;
    await writeState(projectDir, state, { clock: CREATED_AT });
    const envelope = JSON.parse(await readFile(path.join(projectDir, '.noosphere', 'continuity.json'), 'utf8'));
    const kernel = await readFile(path.join(projectDir, '.noosphere', 'continuity.md'), 'utf8');
    assert.match(kernel, new RegExp(envelope.snapshot_id));
    const reread = await readState(projectDir, { clock: CREATED_AT });
    assert.equal(reread.ok, true);
    assert.equal(reread.state.envelope.goal.current_objective, 'Persist ACP state.');
  });

  it('imports a structured handoff through the CLI', async () => {
    const dir = await makeRepo();
    const observed = await observeRepository(dir);
    const candidateFile = path.join(dir, 'handoff.json');
    await writeFile(candidateFile, JSON.stringify(await signedEnvelope(observed)));
    const result = await execFileAsync('node', [CLI, 'handoff', '--file', candidateFile, '--path', dir]);
    assert.match(result.stdout, /ACP handoff stored/);
    const stored = JSON.parse(await readFile(path.join(dir, '.noosphere', 'continuity.json'), 'utf8'));
    assert.equal(stored.goal.current_objective, 'Persist ACP state.');
  });

  it('validates a freshly written state and rejects a tampered kernel', async () => {
    const dir = await makeRepo();
    const observed = await observeRepository(dir);
    const state = decodeEnvelope(await signedEnvelope(observed), { clock: CREATED_AT }).state;
    await writeState(dir, state, { clock: CREATED_AT });
    const ok = await execFileAsync('node', [CLI, 'state', 'validate', '--path', dir]);
    assert.match(ok.stdout, /valid/);

    await writeFile(path.join(dir, '.noosphere', 'continuity.md'), 'tampered\n');
    await assert.rejects(execFileAsync('node', [CLI, 'state', 'validate', '--path', dir]));
  });
});
