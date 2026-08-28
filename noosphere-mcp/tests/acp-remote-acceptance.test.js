import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { encodeEnvelope } from '@noosphere/acp-protocol';
import { testBudgetMs } from './child-process.js';

const execFileAsync = promisify(execFile);
const mcpRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(mcpRoot, '..');
const cli = path.join(mcpRoot, 'continuity', 'index.js');
const relayerEntry = path.join(repositoryRoot, 'noosphere-relayer', 'index.js');
const roots = [];
const TOKEN = 'acceptance-test-token-with-at-least-32-bytes';

after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

describe('ACP clean-machine remote acceptance', () => {
  it('synchronizes exact state through one authenticated durable relayer without semantic recall', async () => {
    const fixture = await startRelayer({ shared: true });
    const machines = await makeMachines(fixture.url);
    try {
      const capabilities = await Promise.all(['A', 'B'].map(() => requestJson(`${fixture.url}/v1/acp/capabilities`)));
      assert.equal(capabilities[0].relayer_index_id, capabilities[1].relayer_index_id);
      assert.equal(capabilities[0].relayer_index_id, fixture.indexId);

      const initial = await runCli(machines.a, ['acp', 'state', '--json']);
      const handoff = path.join(path.dirname(machines.a), 'handoff.json');
      await writeFile(handoff, initial.stdout);
      await runCli(machines.a, ['handoff', '--file', handoff]);

      const durableState = JSON.parse(await readFile(fixture.statePath, 'utf8'));
      const persistedIndexId = durableState.exact_state.relayer_index_id;
      assert.equal(persistedIndexId, capabilities[0].relayer_index_id);
      const beforeRestart = capabilities[0].relayer_index_id;
      await fixture.restart();
      const afterRestart = await requestJson(`${fixture.url}/v1/acp/capabilities`);
      assert.equal(afterRestart.relayer_index_id, beforeRestart);
      assert.equal(afterRestart.relayer_index_id, persistedIndexId);

      const discovered = JSON.parse((await runCli(machines.b, ['acp', 'state', 'pull', '--json'])).stdout);
      assert.equal(discovered.action, 'remote-only-restore', JSON.stringify(discovered));
      assert.match(discovered.confirmation_id, /^sha256:[0-9a-f]{64}$/);
      await assert.rejects(readFile(path.join(machines.b, '.noosphere', 'continuity.json')));

      const applied = JSON.parse((await runCli(machines.b, [
        'state', 'pull', '--json', '--confirm-remote', discovered.confirmation_id,
      ])).stdout);
      assert.equal(applied.action, 'remote-applied');
      const [aEnvelope, bEnvelope, aKernel, bKernel] = await Promise.all([
        readFile(path.join(machines.a, '.noosphere', 'continuity.json'), 'utf8'),
        readFile(path.join(machines.b, '.noosphere', 'continuity.json'), 'utf8'),
        readFile(path.join(machines.a, '.noosphere', 'continuity.md'), 'utf8'),
        readFile(path.join(machines.b, '.noosphere', 'continuity.md'), 'utf8'),
      ]);
      assert.deepEqual(JSON.parse(bEnvelope), JSON.parse(aEnvelope));
      assert.equal(bKernel, aKernel);
      assert.equal(fixture.semanticRequests.length, 0);
    } finally {
      await fixture.stop();
    }
  });

  it('rejects changed topology and stale observations, and keeps advanced state historical by default', async () => {
    const primary = await startRelayer({ shared: true });
    const secondary = await startRelayer({ shared: true });
    const machines = await makeMachines(primary.url, 'negative-project');
    try {
      const initial = await runCli(machines.a, ['acp', 'state', '--json']);
      const handoff = path.join(path.dirname(machines.a), 'negative-handoff.json');
      await writeFile(handoff, initial.stdout);
      await runCli(machines.a, ['handoff', '--file', handoff]);

      const topologyConfirmation = JSON.parse((await runCli(machines.b, ['acp', 'state', 'pull', '--json'])).stdout);
      await configureMachine(machines.b, secondary.url, 'negative-project');
      await assert.rejects(runCli(machines.b, [
        'state', 'pull', '--json', '--confirm-remote', topologyConfirmation.confirmation_id,
      ]), /confirmation-stale/);
      assert.notEqual(primary.indexId, secondary.indexId);

      await configureMachine(machines.b, primary.url, 'negative-project');
      const staleConfirmation = JSON.parse((await runCli(machines.b, ['acp', 'state', 'pull', '--json'])).stdout);
      await writeFile(path.join(machines.b, 'advanced.txt'), 'new revision\n');
      await git(machines.b, ['add', 'advanced.txt']);
      await git(machines.b, ['-c', 'user.email=acceptance@example.com', '-c', 'user.name=Acceptance', 'commit', '-m', 'advance B']);
      await assert.rejects(runCli(machines.b, [
        'state', 'pull', '--json', '--confirm-remote', staleConfirmation.confirmation_id,
      ]), /confirmation-stale/);

      const historical = JSON.parse((await runCli(machines.b, ['acp', 'state', 'pull', '--json'])).stdout);
      assert.equal(historical.action, 'historical-advanced');
      assert.equal(historical.confirmation_id, null);
      const override = JSON.parse((await runCli(machines.b, [
        'state', 'pull', '--json', '--allow-stale-advanced',
      ])).stdout);
      assert.match(override.confirmation_id, /^sha256:/);
      await assert.rejects(runCli(machines.b, [
        'state', 'pull', '--json', '--confirm-remote', override.confirmation_id,
      ]), /confirmation-override-mismatch/);
      const secondOverride = JSON.parse((await runCli(machines.b, [
        'state', 'pull', '--json', '--allow-stale-advanced',
      ])).stdout);
      await runCli(machines.b, [
        'state', 'pull', '--json', '--allow-stale-advanced', '--confirm-remote', secondOverride.confirmation_id,
      ]);
      assert.match(await readFile(path.join(machines.b, '.noosphere', 'continuity.md'), 'utf8'), /STALE HISTORY/);
    } finally {
      await Promise.all([primary.stop(), secondary.stop()]);
    }
  });

  it('reports local-only topology and never confirms an expired remote snapshot', async () => {
    const localOnly = await startRelayer({ shared: false });
    const machines = await makeMachines(localOnly.url, 'expired-project');
    try {
      const capabilities = await requestJson(`${localOnly.url}/v1/acp/capabilities`);
      assert.equal(capabilities.cross_machine_recoverable, false);
      assert.equal(capabilities.deployment_mode, 'local-only');

      const initial = JSON.parse((await runCli(machines.a, ['acp', 'state', '--json'])).stdout);
      initial.expires_at = new Date(Date.now() + 1_000).toISOString();
      const expired = encodeEnvelope({ envelope: initial });
      const handoff = path.join(path.dirname(machines.a), 'expired-handoff.json');
      await writeFile(handoff, JSON.stringify(expired));
      await runCli(machines.a, ['handoff', '--file', handoff]);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const result = JSON.parse((await runCli(machines.b, ['acp', 'state', 'pull', '--json'])).stdout);
      assert.equal(result.action, 'quarantine');
      assert.equal(result.reason, 'remote-expired');
      assert.equal(result.confirmation_id, null);
    } finally {
      await localOnly.stop();
    }
  });
});

async function makeMachines(relayerUrl, projectId = 'acceptance-project') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'noosphere-acp-acceptance-'));
  roots.push(root);
  const source = path.join(root, 'source');
  const a = path.join(root, 'machine-a');
  const b = path.join(root, 'machine-b');
  await mkdir(source);
  await git(source, ['init', '--initial-branch=main']);
  await git(source, ['config', 'user.email', 'acceptance@example.com']);
  await git(source, ['config', 'user.name', 'Acceptance']);
  await writeFile(path.join(source, 'README.md'), '# acceptance\n');
  await git(source, ['add', 'README.md']);
  await git(source, ['commit', '-m', 'initial']);
  await git(root, ['clone', source, a]);
  await git(root, ['clone', source, b]);
  for (const machine of [a, b]) {
    await runCli(machine, ['init']);
    await configureMachine(machine, relayerUrl, projectId);
  }
  return { a, b };
}

async function configureMachine(machine, relayerUrl, projectId) {
  const configPath = path.join(machine, '.noosphere', 'config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.project_id = projectId;
  config.relayer_url = relayerUrl;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function startRelayer({ shared }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'noosphere-relayer-acceptance-'));
  roots.push(root);
  const backendPort = await freePort();
  const proxyPort = await freePort();
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  const url = `http://127.0.0.1:${proxyPort}`;
  const requests = [];
  const semanticRequests = [];
  const statePath = path.join(root, 'state.json');
  const environment = {
    ...process.env,
    NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(backendPort),
    NOOSPHERE_API_TOKEN: TOKEN, ALLOW_LOOPBACK_WITHOUT_TOKEN: 'false',
    NOOSPHERE_MEMORY_BACKEND: 'local-file',
    LOCAL_MEMORY_PATH: path.join(root, 'semantic.json'),
    NOOSPHERE_STATE_PATH: statePath,
    NOOSPHERE_SNAPSHOT_PATH: path.join(root, 'snapshots'),
    NOOSPHERE_SHARED_RELAYER: String(shared),
    UPLOAD_MIN_INTERVAL_MS: '1',
  };
  let child;
  const launch = async () => {
    child = spawn(process.execPath, [relayerEntry], {
      cwd: path.dirname(relayerEntry), env: environment, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => requests.push(`stdout ${chunk.toString()}`));
    child.stderr.on('data', (chunk) => requests.push(`stderr ${chunk.toString()}`));
    await waitFor(async () => {
      try { return (await requestJson(`${backendUrl}/v1/acp/capabilities`)).relayer_index_id; } catch { return null; }
    });
  };
  const stopChild = async () => {
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('close', resolve));
  };
  await launch();
  const proxy = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.url === '/v1/actions'
      || /\/v1\/projects\/[^/]+\/(?:recall|context|bootstrap)(?:\?|$)/.test(request.url)) {
      semanticRequests.push(`${request.method} ${request.url}`);
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end('{"error":"semantic-disabled-by-acceptance-fixture"}');
      return;
    }
    const upstream = http.request(`${backendUrl}${request.url}`, {
      method: request.method, headers: request.headers,
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on('error', (error) => response.destroy(error));
    request.pipe(upstream);
  });
  await new Promise((resolve) => proxy.listen(proxyPort, '127.0.0.1', resolve));
  await waitFor(async () => {
    try { return (await requestJson(`${url}/v1/acp/capabilities`)).relayer_index_id; } catch { return null; }
  });
  const capability = await requestJson(`${url}/v1/acp/capabilities`);
  return {
    url, requests, semanticRequests, statePath, indexId: capability.relayer_index_id,
    restart: async () => { await stopChild(); await launch(); },
    stop: async () => {
      await stopChild();
      proxy.closeAllConnections?.();
      await new Promise((resolve) => proxy.close(resolve));
    },
  };
}

async function runCli(root, args) {
  return execFileAsync(process.execPath, [cli, ...args, '--path', root], {
    cwd: root,
    env: { ...process.env, NOOSPHERE_API_TOKEN: TOKEN, NOOSPHERE_HOME: path.join(root, '.home') },
    maxBuffer: 2_000_000,
  });
}

async function requestJson(url) {
  const response = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } });
  if (!response.ok) throw new Error(`${response.status}`);
  return response.json();
}

async function git(cwd, args) { await execFileAsync('git', args, { cwd }); }

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(probe, timeout = 8_000) {
  const budgetMs = testBudgetMs(timeout);
  const started = Date.now();
  while (Date.now() - started < budgetMs) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('relayer-start-timeout');
}
