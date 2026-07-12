import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { ACP_PROTOCOL, ACP_SCHEMA_VERSION } from '../continuity/acp/project-state.js';
import { decodeEnvelope, digestEnvelope } from '../continuity/acp/wire.js';
import { classifyCompatibility, observeRepository } from '../continuity/acp/git-state.js';

const execFileAsync = promisify(execFile);
const CREATED_AT = '2026-07-12T00:00:00.000Z';
const dirs = [];

async function makeRepo(commit = true) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'noosphere-acp-git-'));
  dirs.push(dir);
  await execFileAsync('git', ['init'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  if (commit) {
    await writeFile(path.join(dir, 'README.md'), `# Repo ${path.basename(dir)}\n`);
    await execFileAsync('git', ['add', '.'], { cwd: dir });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: dir });
  }
  return dir;
}

async function commitFile(dir, name, body) {
  await writeFile(path.join(dir, name), body);
  await execFileAsync('git', ['add', '.'], { cwd: dir });
  await execFileAsync('git', ['commit', '-m', `add ${name}`], { cwd: dir });
}

// Build a decoded ProjectState whose repository fields match an observation.
function stateFor(observed) {
  const envelope = {
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
    goal: {
      project: 'Continuity.',
      current_objective: 'Classify repository freshness.',
      success_conditions: ['A fresh agent trusts the classification.'],
    },
    plan: [], completed_work: [], decisions: [], evidence: [], assumptions: [],
    rejected_approaches: [], unknowns: [], blockers: [], risks: [], conflicts: [],
    working_stance: {
      confidence: 'medium', momentum: 'progressing', risk_posture: 'verify-before-change',
      attention: [], dissatisfaction: [], successor_behavior: [],
    },
    next_actions: [], references: [], extensions: {},
  };
  const digest = digestEnvelope(envelope);
  envelope.integrity.digest = digest;
  envelope.snapshot_id = `sha256:${digest}`;
  const result = decodeEnvelope(envelope, { clock: CREATED_AT });
  assert.equal(result.ok, true);
  return result.state;
}

describe('observeRepository / classifyCompatibility', () => {
  let projectDir;

  before(async () => {
    projectDir = await makeRepo();
  });

  after(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('marks a matching checkout exact', async () => {
    const observed = await observeRepository(projectDir);
    assert.deepEqual(classifyCompatibility(stateFor(observed), observed), {
      status: 'exact', trustDowngrade: 0, actionable: true, reasons: [],
    });
  });

  it('marks a foreign repository as foreign', async () => {
    const observed = await observeRepository(projectDir);
    const other = await observeRepository(await makeRepo());
    const result = classifyCompatibility(stateFor(other), observed);
    assert.equal(result.status, 'foreign');
    assert.equal(result.actionable, false);
  });

  it('marks a descendant HEAD as advanced', async () => {
    const before = await observeRepository(projectDir);
    await commitFile(projectDir, 'next.txt', 'more work\n');
    const after2 = await observeRepository(projectDir);
    const result = classifyCompatibility(stateFor(before), after2);
    assert.equal(result.status, 'advanced');
    assert.equal(result.actionable, true);
  });

  it('marks a diverged branch as diverged', async () => {
    const mainObserved = await observeRepository(projectDir);
    await execFileAsync('git', ['checkout', '-b', 'side', 'HEAD~1'], { cwd: projectDir });
    await commitFile(projectDir, 'side.txt', 'divergent\n');
    const sideObserved = await observeRepository(projectDir);
    const result = classifyCompatibility(stateFor(mainObserved), sideObserved);
    assert.equal(result.status, 'diverged');
    assert.equal(result.actionable, false);
    await execFileAsync('git', ['checkout', 'HEAD'], { cwd: projectDir }).catch(() => {});
  });

  it('ignores .noosphere-only changes', async () => {
    const dir = await makeRepo();
    const observed = await observeRepository(dir);
    const state = stateFor(observed);
    await mkdir(path.join(dir, '.noosphere'), { recursive: true });
    await writeFile(path.join(dir, '.noosphere', 'journal.md'), 'local only\n');
    const after2 = await observeRepository(dir);
    assert.equal(classifyCompatibility(state, after2).status, 'exact');
  });

  it('classifies an unborn repository as unknown', async () => {
    const dir = await makeRepo(false);
    const observed = await observeRepository(dir);
    assert.equal(observed.head, null);
    const anyState = stateFor(await observeRepository(projectDir));
    const result = classifyCompatibility(anyState, observed);
    assert.equal(result.status, 'unknown');
    assert.equal(result.actionable, false);
  });
});
