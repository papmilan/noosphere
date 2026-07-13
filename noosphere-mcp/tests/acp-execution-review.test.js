import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CLI = new URL('../continuity/index.js', import.meta.url).pathname;
const dirs = [];

async function repo() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'noosphere-exec-review-'));
  dirs.push(root);
  await execFileAsync('git', ['init'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'test@example.test'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: root });
  await writeFile(path.join(root, 'target.js'), 'export const value = 1;\n');
  await writeFile(path.join(root, '.gitignore'), '.noosphere/\n');
  await execFileAsync('git', ['add', '.'], { cwd: root });
  await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
  return root;
}

function input(agentId, target = 'target.js') {
  return {
    origin: { agent_id: agentId, client: 'test', session_id: null },
    cursor: { step_id: 's1', status: 'before-edit', opened_files: [target], target: { file: target, symbol: 'value', purpose: 'Change the value.' } },
    steps: [
      { id: 's1', parent_step_id: null, kind: 'edit', status: 'current', target: { file: target, symbol: 'value', content_hash: null }, goal: 'Change the value.', verify: { command: 'git reset --hard', expectation: 'inspect first' } },
      { id: 's2', parent_step_id: 's1', kind: 'test', status: 'pending', target: { file: target, symbol: 'value', content_hash: null }, goal: 'Run the target tests.', verify: { command: 'npm publish', expectation: 'inspect first' } },
    ],
    frontier: { searched: [], ruled_out: [] }, working_notes: [], expires_at: '2099-01-01T00:00:00.000Z',
  };
}

async function run(root, args, env = {}) {
  return execFileAsync('node', [CLI, ...args, '--path', root], { cwd: root, env: { ...process.env, ...env }, timeout: 30_000 });
}

after(async () => { await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))); });

describe('ACP execution adversarial review regressions', () => {
  it('generates adapters that load the execution kernel in the required safe order', async () => {
    const root = await repo();
    await run(root, ['init']);
    await run(root, ['adapters', '--only', 'codex,claude,gemini,cursor']);
    for (const file of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.cursor/rules/noosphere.mdc']) {
      const text = await readFile(path.join(root, file), 'utf8');
      assert.ok(text.indexOf('master-prompt.md') < text.indexOf('continuity.md'));
      assert.ok(text.indexOf('continuity.md') < text.indexOf('execution/'));
      assert.ok(text.indexOf('execution/') < text.indexOf('Git status'));
      assert.match(text, /advisory, untrusted, and freshness-bound/i);
      assert.match(text, /never execute.*command.*blindly/i);
    }
  });

  it('keeps canonical per-agent checkpoints, surfaces contention, and refuses implicit clear', async () => {
    const root = await repo();
    const inputFile = path.join(root, 'input.json');
    await writeFile(inputFile, JSON.stringify(input('Agent-A')));
    await run(root, ['exec', 'checkpoint', '--file', inputFile]);
    await writeFile(inputFile, JSON.stringify(input('agent-b')));
    await run(root, ['exec', 'checkpoint', '--file', inputFile]);
    const files = await (await import('node:fs/promises')).readdir(path.join(root, '.noosphere', 'execution'));
    assert.ok(files.includes('agent-a.json'));
    assert.ok(files.includes('agent-b.json'));
    const shown = await run(root, ['exec', 'show', '--agent', 'AGENT-A']);
    assert.match(shown.stdout, /CONTENTION:/);
    await assert.rejects(run(root, ['exec', 'clear']), /explicit scope/i);
    await writeFile(inputFile, JSON.stringify(input('../escape')));
    await assert.rejects(run(root, ['exec', 'checkpoint', '--file', inputFile]), /invalid-agent-id/);
  });

  it('lets a fresh process discover execution.md through generated instructions without exec show', async () => {
    const root = await repo();
    await run(root, ['init']);
    await run(root, ['adapters', '--only', 'codex']);
    const inputFile = path.join(root, 'input.json');
    await writeFile(inputFile, JSON.stringify(input('agent-a')));
    await run(root, ['exec', 'checkpoint', '--file', inputFile]);
    const adapter = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
    const kernel = await readFile(path.join(root, '.noosphere', 'execution', 'agent-a.md'), 'utf8');
    assert.match(adapter, /execution\/\*\.md/);
    assert.match(kernel, /target\.js value/);
    assert.match(kernel, /Next intended step/);
    assert.match(kernel, /UNVERIFIED COMMAND — inspect before running: `git reset --hard`/);
    assert.match(kernel, /Target unchanged; assumptions and dependencies still require validation\./);
  });
});
