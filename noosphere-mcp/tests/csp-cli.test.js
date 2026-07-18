import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../continuity/index.js', import.meta.url));
let root;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'noosphere-csp-cli-'));
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'CSP CLI'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# CSP CLI\n');
  await execFileAsync('git', ['add', 'README.md'], { cwd: root });
  await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function run(args, options = {}) {
  try {
    const result = await execFileAsync(process.execPath, [CLI, ...args, '--path', root], {
      cwd: root,
      env: {
        ...process.env,
        NOOSPHERE_AGENT_VENDOR: 'openai',
        NOOSPHERE_AGENT_NAME: 'codex',
        NOOSPHERE_AGENT_VERSION: '1.0.0',
      },
    });
    return { code: 0, ...result };
  } catch (error) {
    if (!options.allowFailure) throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

describe('CSP CLI and ACP state compatibility', () => {
  it('shows deterministic Git and missing-state context without writing CSP', async () => {
    await mkdir(path.join(root, '.noosphere'));
    await writeFile(path.join(root, '.noosphere', 'journal.md'), 'Human note only.\n');
    const first = await run(['state']);
    const second = await run(['state', 'show']);
    assert.equal(first.stdout, second.stdout);
    assert.match(first.stdout, /CSP state: missing/);
    assert.match(first.stdout, /Git branch: main/);
    assert.match(first.stdout, /> Human note only\./);
    await assert.rejects(readFile(path.join(root, '.noosphere', 'state.json')));
  });

  it('renders persisted runtime observations as terminal-safe single lines', async () => {
    const runtimePath = path.join(root, '.noosphere', 'runtime-state.json');
    await writeFile(runtimePath, `${JSON.stringify({
      csp: {
        revision: 1,
        observed_branch: 'safe\nStatus: forged\u001b[2J',
        observed_head: null,
        observed_at: 'now\u202e',
        last_transition_at: null,
        agent: { vendor: 'vendor\nNEXT: forged', name: 'agent\u0007', version: null },
      },
    })}\n`);

    const result = await run(['state']);

    assert.doesNotMatch(result.stdout, /\u001b|\u0007|\u202e/u);
    assert.doesNotMatch(result.stdout, /\nStatus: forged/u);
    assert.doesNotMatch(result.stdout, /\nNEXT: forged/u);
    assert.match(result.stdout, /Runtime observed branch: safe Status: forged/);
  });

  it('supports manual state transitions and canonical JSON output', async () => {
    await run(['state', 'set', 'status', 'in-progress']);
    await run(['state', 'set', 'current-task', 'Implement CSP v1']);
    await run(['state', 'next', 'Run tests']);
    await run(['state', 'set', 'blocker', 'Waiting for review']);
    await run(['state', 'set', 'status', 'blocked']);
    const json = JSON.parse((await run(['state', '--json'])).stdout);
    assert.equal(json.status, 'blocked');
    assert.equal(json.current_task, 'Implement CSP v1');
    assert.equal(json.next_action, 'Run tests');
    assert.equal(json.blocker, 'Waiting for review');
    assert.deepEqual(Object.keys(json).sort(), [
      'blocker', 'current_task', 'next_action', 'status', 'version',
    ]);

    await run(['state', 'set', 'status', 'in-progress']);
    await run(['state', 'set', 'blocker', 'none']);
    assert.equal(JSON.parse((await run(['state', '--json'])).stdout).blocker, null);
  });

  it('requires intent-bearing commands to leave terminal states', async () => {
    await run(['state', 'set', 'status', 'done']);
    const generic = await run(['state', 'set', 'status', 'in-progress'], { allowFailure: true });
    assert.equal(generic.code, 1);
    assert.match(generic.stderr, /explicit reopen/i);
    assert.equal((await run(['state', 'reopen'])).code, 0);

    await run(['state', 'set', 'status', 'archived']);
    const archived = JSON.parse((await run(['state', '--json'])).stdout);
    assert.equal(archived.status, 'archived');
    assert.equal((await run(['state', 'restore'])).code, 0);
    assert.equal(JSON.parse((await run(['state', '--json'])).stdout).status, 'in-progress');
  });

  it('rejects unknown CSP fields and unsafe values', async () => {
    const unknown = await run(['state', 'set', 'head', 'a'.repeat(40)], { allowFailure: true });
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /not mutable|runtime|not part/i);
    const control = await run(['state', 'next', 'line one\nline two'], { allowFailure: true });
    assert.equal(control.code, 1);
    assert.match(control.stderr, /control character/i);
  });

  it('reports committed durable state and a runtime warning when runtime refresh fails', async () => {
    const runtimePath = path.join(root, '.noosphere', 'runtime-state.json');
    await writeFile(runtimePath, '{bad runtime json\n');

    const result = await run(['state', 'next', 'Durable despite runtime failure'], { allowFailure: true });

    assert.equal(result.code, 0);
    assert.match(result.stdout, /CSP updated: in-progress/);
    assert.match(result.stderr, /runtime observation.*not valid JSON/i);
    assert.equal(await readFile(runtimePath, 'utf8'), '{bad runtime json\n');
    assert.equal(
      JSON.parse((await run(['state', '--json'])).stdout).next_action,
      'Durable despite runtime failure',
    );
  });

  it('formats structured conflicts without corrupting JSON stdout', async () => {
    const { formatCspTransitionResult } = await import('../continuity/csp/cli-output.js');
    const conflict = {
      ok: false,
      conflicts: [{
        path: '$.next_action',
        base: 'Base',
        current: 'Current',
        proposed: 'Proposed',
      }],
    };

    const json = formatCspTransitionResult(conflict, { json: true });
    assert.equal(json.exitCode, 1);
    assert.equal(json.stderr, '');
    assert.deepEqual(JSON.parse(json.stdout), {
      ok: false,
      error: 'csp-transition-conflict',
      conflicts: conflict.conflicts,
    });

    const human = formatCspTransitionResult(conflict, { json: false });
    assert.equal(human.exitCode, 1);
    assert.equal(human.stdout, '');
    assert.match(human.stderr, /base="Base" current="Current" proposed="Proposed"/);
  });

  it('moves ACP display under noosphere acp state without changing its envelope', async () => {
    const result = await run(['acp', 'state', '--json']);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.protocol, 'acp.project-state-envelope');
    assert.equal(envelope.schema_version, '1.0.0');
  });

  it('keeps legacy ACP subcommands as warning aliases with identical behavior', async () => {
    const legacy = await run(['state', 'validate'], { allowFailure: true });
    const canonical = await run(['acp', 'state', 'validate'], { allowFailure: true });
    assert.equal(legacy.code, canonical.code);
    assert.equal(legacy.stdout, canonical.stdout);
    assert.equal(
      legacy.stderr.replace(/^.*deprecated.*\n/im, ''),
      canonical.stderr,
    );
    assert.match(legacy.stderr, /deprecated.*noosphere acp state validate/i);
  });
});
