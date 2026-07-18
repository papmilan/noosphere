import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { promisify } from 'node:util';

import { loadState } from '../continuity/csp/storage.js';
import { recordRuntimeObservation } from '../continuity/csp/runtime.js';
import { transitionState } from '../continuity/csp/transitions.js';

const execFileAsync = promisify(execFile);
const roots = [];
const CLOCK = '2026-07-18T20:10:00.000Z';
const AGENT = { vendor: 'openai', name: 'codex', version: null };

async function makeRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'noosphere-csp-transition-'));
  roots.push(root);
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'CSP Test'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# CSP\n');
  await execFileAsync('git', ['add', 'README.md'], { cwd: root });
  await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
  return root;
}

function options(overrides = {}) {
  return { clock: CLOCK, agent: AGENT, ...overrides };
}

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('CSP transition state machine', () => {
  it('writes only durable task truth and keeps measured metadata in runtime state', async () => {
    const root = await makeRepo();
    const result = await transitionState(root, {
      type: 'set',
      changes: { status: 'in-progress', current_task: 'Implement CSP' },
    }, options());
    const { stdout: head } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root });
    assert.equal(result.ok, true);
    assert.deepEqual(result.state, {
      version: 1,
      status: 'in-progress',
      current_task: 'Implement CSP',
      next_action: null,
      blocker: null,
    });
    const runtime = JSON.parse(await readFile(path.join(root, '.noosphere', 'runtime-state.json')));
    assert.equal(runtime.csp.revision, 1);
    assert.equal(runtime.csp.observed_branch, 'main');
    assert.equal(runtime.csp.observed_head, head.trim());
    assert.deepEqual(runtime.csp.agent, AGENT);
    assert.equal(runtime.csp.last_transition_at, CLOCK);
    assert.match(runtime.csp.state_identity, /^[0-9a-f]{64}$/u);
  });

  it('committing state.json cannot make its own durable contents stale', async () => {
    const root = await makeRepo();
    await transitionState(root, {
      type: 'set', changes: { status: 'in-progress', current_task: 'Commit CSP' },
    }, options());
    const statePath = path.join(root, '.noosphere', 'state.json');
    const before = await readFile(statePath);
    await execFileAsync('git', ['add', '.noosphere/state.json'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'track durable CSP'], { cwd: root });
    await recordRuntimeObservation(root, options());
    assert.deepEqual(await readFile(statePath), before);
    assert.equal(Object.hasOwn(JSON.parse(before), 'head'), false);
  });

  it('agent and branch observations never rewrite tracked CSP', async () => {
    const root = await makeRepo();
    await transitionState(root, { type: 'set', changes: { status: 'in-progress' } }, options());
    const statePath = path.join(root, '.noosphere', 'state.json');
    const before = await readFile(statePath);
    await execFileAsync('git', ['switch', '-c', 'review'], { cwd: root });
    const otherAgent = { vendor: 'other', name: 'reviewer', version: '2' };
    await recordRuntimeObservation(root, options({ agent: otherAgent }));
    assert.deepEqual(await readFile(statePath), before);
    const runtime = JSON.parse(await readFile(path.join(root, '.noosphere', 'runtime-state.json')));
    assert.equal(runtime.csp.observed_branch, 'review');
    assert.deepEqual(runtime.csp.agent, otherAgent);
    assert.equal(runtime.csp.revision, 1);
  });

  it('upgrades legacy local excludes before runtime observation and explicit CSP creation', async () => {
    const root = await makeRepo();
    const noosphere = path.join(root, '.noosphere');
    await mkdir(noosphere);
    await writeFile(
      path.join(noosphere, 'state.json'),
      `${JSON.stringify({ last_blob_id: 'legacy-runtime' })}\n`,
    );
    await appendFile(path.join(root, '.git', 'info', 'exclude'), '.noosphere/state.json\n');

    await recordRuntimeObservation(root, options());

    await assert.rejects(readFile(path.join(noosphere, 'state.json')), (error) => error.code === 'ENOENT');
    assert.equal(
      (await execFileAsync('git', ['status', '--porcelain=v1', '--', '.noosphere/runtime-state.json'], { cwd: root })).stdout,
      '',
    );

    await transitionState(root, { type: 'set', changes: { status: 'in-progress' } }, options());
    await assert.rejects(
      execFileAsync('git', ['check-ignore', '.noosphere/state.json'], { cwd: root }),
      (error) => error.code === 1,
    );
    assert.match(
      (await execFileAsync('git', ['status', '--porcelain=v1', '--', '.noosphere/state.json'], { cwd: root })).stdout,
      /\.noosphere\/state\.json/u,
    );
  });

  it('reports a durable transition as committed when corrupt runtime metadata cannot be refreshed', async () => {
    const root = await makeRepo();
    const noosphere = path.join(root, '.noosphere');
    const runtimePath = path.join(noosphere, 'runtime-state.json');
    await mkdir(noosphere);
    await writeFile(runtimePath, '{bad runtime json\n');

    const result = await transitionState(
      root,
      { type: 'set', changes: { status: 'in-progress' } },
      options(),
    );

    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.equal(result.state.status, 'in-progress');
    assert.equal(result.runtime, null);
    assert.equal(result.runtime_error.code, 'runtime-state-json-invalid');
    assert.equal(await readFile(runtimePath, 'utf8'), '{bad runtime json\n');
    assert.equal((await loadState(root)).status, 'in-progress');
  });

  it('preserves unknown runtime keys inside and outside the CSP observation namespace', async () => {
    const root = await makeRepo();
    const noosphere = path.join(root, '.noosphere');
    await mkdir(noosphere);
    await writeFile(path.join(noosphere, 'runtime-state.json'), `${JSON.stringify({
      watcher_extension: { retained: true },
      csp: { future_observation: { retained: true }, revision: 9 },
    })}\n`);

    await recordRuntimeObservation(root, options());

    const runtime = JSON.parse(await readFile(path.join(noosphere, 'runtime-state.json'), 'utf8'));
    assert.deepEqual(runtime.watcher_extension, { retained: true });
    assert.deepEqual(runtime.csp.future_observation, { retained: true });
  });

  it('does not rewrite tracked CSP when an explicit transition leaves task truth unchanged', async () => {
    const root = await makeRepo();
    await transitionState(root, { type: 'set', changes: { status: 'in-progress' } }, options());
    const statePath = path.join(root, '.noosphere', 'state.json');
    const before = await readFile(statePath);
    const result = await transitionState(
      root,
      { type: 'set', changes: { status: 'in-progress' } },
      options({ agent: { vendor: 'other', name: 'agent', version: null } }),
    );
    assert.equal(result.changed, false);
    assert.deepEqual(await readFile(statePath), before);
    assert.equal(result.runtime.revision, 1);
  });

  it('enforces allowed status edges and the blocked invariant', async () => {
    const root = await makeRepo();
    await assert.rejects(
      transitionState(root, { type: 'set', changes: { status: 'blocked' } }, options()),
      (error) => error.code === 'csp-transition-invalid',
    );
    await transitionState(root, { type: 'set', changes: { status: 'in-progress' } }, options());
    const blocked = await transitionState(root, {
      type: 'set', changes: { status: 'blocked', blocker: 'Waiting for approval' },
    }, options());
    assert.equal(blocked.state.status, 'blocked');
    const active = await transitionState(root, {
      type: 'set', changes: { status: 'in-progress' },
    }, options());
    assert.equal(active.state.blocker, 'Waiting for approval');
    const cleared = await transitionState(root, {
      type: 'set', changes: { blocker: null },
    }, options());
    assert.equal(cleared.state.blocker, null);
  });

  it('requires explicit reopen and restore intent for terminal states', async () => {
    const doneRoot = await makeRepo();
    await transitionState(doneRoot, { type: 'set', changes: { status: 'in-progress' } }, options());
    await transitionState(doneRoot, { type: 'set', changes: { status: 'done' } }, options());
    await assert.rejects(
      transitionState(doneRoot, { type: 'set', changes: { status: 'in-progress' } }, options()),
      (error) => error.code === 'csp-terminal-intent-required',
    );
    assert.equal((await transitionState(doneRoot, { type: 'reopen' }, options())).state.status, 'in-progress');

    const archivedRoot = await makeRepo();
    await transitionState(archivedRoot, { type: 'set', changes: { status: 'archived' } }, options());
    await assert.rejects(
      transitionState(archivedRoot, { type: 'resume' }, options()),
      (error) => error.code === 'csp-transition-invalid',
    );
    assert.equal((await transitionState(archivedRoot, { type: 'restore' }, options())).state.status, 'in-progress');
  });

  it('rejects caller attempts to put runtime fields in tracked CSP', async () => {
    const root = await makeRepo();
    for (const field of ['version', 'agent', 'branch', 'head', 'revision', 'last_update']) {
      await assert.rejects(
        transitionState(root, { type: 'set', changes: { [field]: null } }, options()),
        (error) => error.code === 'csp-transition-field' || error.code === 'csp-managed-field',
      );
    }
  });

  it('merges independent concurrent durable transitions', async () => {
    const root = await makeRepo();
    await transitionState(root, { type: 'set', changes: { status: 'in-progress' } }, options());
    const result = await transitionState(root, {
      type: 'set', changes: { current_task: 'Outer task' },
    }, options({
      beforeCommit: async () => {
        await transitionState(root, {
          type: 'set', changes: { next_action: 'Concurrent next action' },
        }, options());
      },
    }));
    assert.equal(result.ok, true);
    assert.equal(result.state.current_task, 'Outer task');
    assert.equal(result.state.next_action, 'Concurrent next action');
  });

  it('returns structured conflicts without overwriting concurrent edits', async () => {
    const root = await makeRepo();
    await transitionState(root, {
      type: 'set', changes: { status: 'in-progress', next_action: 'Base action' },
    }, options());
    const result = await transitionState(root, {
      type: 'set', changes: { next_action: 'Outer action' },
    }, options({
      beforeCommit: async () => {
        await transitionState(root, {
          type: 'set', changes: { next_action: 'Concurrent action' },
        }, options());
      },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.conflicts[0].path, '$.next_action');
    const stored = await loadState(root);
    assert.equal(stored.next_action, 'Concurrent action');
  });

  it('explicit task transitions update state safely without embedding Git HEAD', async () => {
    const root = await makeRepo();
    await transitionState(root, { type: 'set', changes: { status: 'in-progress' } }, options());
    const before = await readFile(path.join(root, '.noosphere', 'state.json'));
    const result = await transitionState(root, {
      type: 'set', changes: { next_action: 'Review durable state' },
    }, options());
    const after = await readFile(path.join(root, '.noosphere', 'state.json'));
    assert.notDeepEqual(after, before);
    assert.equal(result.state.next_action, 'Review durable state');
    assert.deepEqual(Object.keys(result.state).sort(), [
      'blocker', 'current_task', 'next_action', 'status', 'version',
    ]);
  });

  it('serializes simultaneous writers and rejects ambiguous same-field edits', async () => {
    const root = await makeRepo();
    await transitionState(root, {
      type: 'set', changes: { status: 'in-progress', current_task: 'Base' },
    }, options());
    let arrivals = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const beforeCommit = async () => {
      arrivals += 1;
      if (arrivals === 2) release();
      await gate;
    };
    const results = await Promise.all([
      transitionState(root, { type: 'set', changes: { current_task: 'Writer A' } }, options({ beforeCommit })),
      transitionState(root, { type: 'set', changes: { current_task: 'Writer B' } }, options({ beforeCommit })),
    ]);
    assert.equal(results.filter((entry) => entry.ok).length, 1);
    assert.equal(results.filter((entry) => !entry.ok).length, 1);
    assert.match((await loadState(root)).current_task, /^Writer [AB]$/u);
  });
});
