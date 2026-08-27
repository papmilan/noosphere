import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../continuity/index.js', import.meta.url));
const dirs = [];

async function makeRepo() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'noosphere-exec-cli-'));
  dirs.push(dir);
  await execFileAsync('git', ['init'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 't@example.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await writeFile(path.join(dir, 'app.js'), 'export const answer = 42;\n');
  await writeFile(path.join(dir, '.gitignore'), '.noosphere/\n');
  await execFileAsync('git', ['add', '.'], { cwd: dir });
  await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: dir });
  return dir;
}

function run(args, cwd) {
  return execFileAsync('node', [CLI, ...args, '--path', cwd], { timeout: 30_000 });
}

function assertedInput(overrides = {}) {
  return {
    origin: { agent_id: 'claude', client: 'claude-code', session_id: null },
    cursor: {
      step_id: 's1',
      status: 'before-edit',
      opened_files: ['app.js'],
      target: { file: 'app.js', symbol: 'answer', purpose: 'Bump the answer.' },
    },
    steps: [
      {
        id: 's1', parent_step_id: null, kind: 'edit', status: 'current',
        target: { file: 'app.js', symbol: 'answer', content_hash: `sha256:${'f'.repeat(64)}` },
        goal: 'Bump the answer.', verify: { command: 'node --test tests/app.test.js', expectation: 'pass' },
      },
    ],
    frontier: { searched: [], ruled_out: [] },
    // Attempted lie: the CLI must ignore asserted validation and repository.
    validation: { last_command: 'echo lies', last_result: 'pass', failing_tests: [] },
    repository: { project_id: 'lies', head: '0'.repeat(40), branch: 'lies', dirty: true, workspace_fingerprint: `sha256:${'0'.repeat(64)}` },
    ...overrides,
  };
}

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('ACP execution CLI', () => {
  let repo;

  before(async () => {
    repo = await makeRepo();
  });

  it('checkpoints with measured fields overriding asserted lies', async () => {
    const inputDir = await mkdtemp(path.join(os.tmpdir(), 'noosphere-exec-input-'));
    dirs.push(inputDir);
    const input = path.join(inputDir, 'exec-input.json');
    await writeFile(input, JSON.stringify(assertedInput()));
    const result = await run(['exec', 'checkpoint', '--file', input], repo);
    assert.match(result.stdout, /Execution checkpoint stored/);

    const stored = JSON.parse(await readFile(path.join(repo, '.noosphere', 'execution', 'claude.json'), 'utf8'));
    const appHash = `sha256:${createHash('sha256').update(await readFile(path.join(repo, 'app.js'))).digest('hex')}`;
    assert.equal(stored.steps[0].target.content_hash, appHash);
    assert.notEqual(stored.repository.workspace_fingerprint, `sha256:${'0'.repeat(64)}`);
    assert.notEqual(stored.repository.branch, 'lies');
    assert.equal(stored.repository.dirty, false);
    assert.equal(stored.validation.last_result, null);
    assert.equal(stored.validation.last_command, null);
    assert.match(stored.project_snapshot_id, /^sha256:[a-f0-9]{64}$/);
    // Default expiry: 72 hours after creation.
    assert.equal(Date.parse(stored.expires_at) - Date.parse(stored.created_at), 72 * 3600 * 1000);
  });

  it('shows the advisory kernel with a fresh verdict for an untouched repository', async () => {
    const result = await run(['exec', 'show'], repo);
    assert.match(result.stdout, /# EXECUTION CHECKPOINT \(advisory/);
    assert.match(result.stdout, /Binding: fresh/);
    assert.match(result.stdout, /Current: edit app\.js answer/);
  });

  it('marks the step stale after the target file changes', async () => {
    await writeFile(path.join(repo, 'app.js'), 'export const answer = 43;\n');
    const result = await run(['exec', 'show'], repo);
    assert.match(result.stdout, /TARGET target-changed: edit app\.js/);
    await execFileAsync('git', ['checkout', '--', 'app.js'], { cwd: repo });
  });

  it('round-trips the envelope through --json', async () => {
    const result = await run(['exec', 'show', '--json'], repo);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.protocol, 'acp.execution-state/1');
    assert.equal(envelope.cursor.step_id, 's1');
  });

  it('imports a markdown checkbox plan as an execution graph', async () => {
    const fresh = await makeRepo();
    const plan = path.join(fresh, 'plan.md');
    await writeFile(plan, [
      '# Plan',
      '- [x] Write the failing test',
      '- [ ] Implement the validator',
      '- [ ] Run the full check suite',
    ].join('\n'));
    const result = await run(['exec', 'import-plan', plan], fresh);
    assert.match(result.stdout, /Imported 3 steps/);
    const stored = JSON.parse(await readFile(path.join(fresh, '.noosphere', 'execution', 'plan-import.json'), 'utf8'));
    assert.equal(stored.steps.length, 3);
    assert.equal(stored.steps[0].status, 'done');
    assert.equal(stored.steps[1].status, 'current');
    assert.equal(stored.steps[2].status, 'pending');
    assert.equal(stored.cursor.step_id, stored.steps[1].id);
    assert.equal(stored.steps[1].goal, 'Implement the validator');
    assert.deepEqual(stored.steps.map(({ parent_step_id: parent }) => parent), [null, 's1', 's2']);
  });

  it('refuses completed or malformed UTF-8 plans instead of inventing a current step', async () => {
    const fresh = await makeRepo();
    const completed = path.join(fresh, 'completed.md');
    await writeFile(completed, '- [x] Already finished\n');
    await assert.rejects(run(['exec', 'import-plan', completed], fresh), /no unchecked step/i);

    const malformed = path.join(fresh, 'malformed.md');
    await writeFile(malformed, Buffer.from([0x2d, 0x20, 0x5b, 0x20, 0x5d, 0x20, 0xc3, 0x28]));
    await assert.rejects(run(['exec', 'import-plan', malformed], fresh), /not valid UTF-8/i);
    await assert.rejects(
      readFile(path.join(fresh, '.noosphere', 'execution', 'plan-import.json')),
      (error) => error.code === 'ENOENT',
    );
  });

  it('clears the checkpoint', async () => {
    const result = await run(['exec', 'clear', '--agent', 'claude'], repo);
    assert.match(result.stdout, /cleared/i);
    const shown = await run(['exec', 'show'], repo);
    assert.match(shown.stdout, /No execution checkpoint/);
  });

  it('fails with a usable message outside a git repository', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'noosphere-exec-nogit-'));
    dirs.push(dir);
    await assert.rejects(run(['exec', 'show'], dir), /git/i);
  });
});
