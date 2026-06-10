import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const mcpEntry = path.join(packageDir, 'mcp-server', 'index.js');
const hookPath = path.join(packageDir, 'hooks', 'post-session.sh');
const installerPath = path.join(packageDir, 'hooks', 'install-hook.sh');

let mockServer;
let mockUrl;
let actions;

before(async () => {
  actions = [];
  mockServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'POST' && url.pathname === '/v1/actions') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const action = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      actions.push(action);
      respondJson(res, 201, {
        success: true,
        blob_id: `blob-${actions.length}`,
        tx_digest: `tx-${actions.length}`,
        score_delta: 7,
        score_reasoning: 'Clear and complete session summary.',
      });
      return;
    }

    const contextMatch = url.pathname.match(
      /^\/v1\/projects\/([^/]+)\/context$/,
    );
    if (req.method === 'GET' && contextMatch) {
      const projectId = decodeURIComponent(contextMatch[1]);
      const context =
        `--- PROJECT CONTEXT: ${projectId} ---\nStored project memory.\n--- END CONTEXT ---`;
      if (
        url.searchParams.get('format') === 'text' ||
        req.headers.accept === 'text/plain'
      ) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(context);
      } else {
        respondJson(res, 200, {
          success: true,
          project_id: projectId,
          context,
          actions: Array.from({ length: 6 }, (_, index) => ({
            timestamp: Date.UTC(2026, 5, 1, index),
            agent_id: index % 2 === 0 ? 'codex' : 'claude-code',
            action_type: index === 5 ? 'debug' : 'code',
            content:
              index === 5
                ? 'Found and fixed the null pointer bug in auth.js.'
                : `Completed shared task ${index + 1}.`,
          })),
        });
      }
      return;
    }

    const agentsMatch = url.pathname.match(
      /^\/v1\/projects\/([^/]+)\/agents$/,
    );
    if (req.method === 'GET' && agentsMatch) {
      respondJson(res, 200, {
        success: true,
        agents: [
          {
            agent_name: 'claude-code',
            reputation_score: 507,
            average_rating: 6.5,
            verified_rating_count: 2,
            decision_count: 3,
            genome_object_id: 'demo-genome-claude',
            provider: 'Anthropic',
          },
        ],
      });
      return;
    }

    respondJson(res, 404, { error: 'not found' });
  });

  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  mockUrl = `http://127.0.0.1:${mockServer.address().port}`;
});

after(async () => {
  await new Promise((resolve) => mockServer.close(resolve));
});

describe('MCP stdio transport', () => {
  it('lists and calls all Noosphere tools', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [mcpEntry, '--stdio'],
      cwd: packageDir,
      env: {
        ...process.env,
        NOOSPHERE_RELAYER_URL: mockUrl,
      },
      stderr: 'pipe',
    });
    const client = new Client({
      name: 'noosphere-test-client',
      version: '1.0.0',
    });

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      assert.deepEqual(
        listed.tools.map((tool) => tool.name).sort(),
        [
          'get_project_context',
          'list_agents',
          'session_end',
          'session_start',
          'store_action',
        ],
      );

      const context = await client.callTool({
        name: 'get_project_context',
        arguments: { project_id: 'stdio-project' },
      });
      assert.match(context.content[0].text, /Stored project memory/);

      const stored = await client.callTool({
        name: 'store_action',
        arguments: {
          project_id: 'stdio-project',
          agent_id: 'codex',
          action_type: 'decision',
          content: 'Selected the shared memory schema.',
          genome_object_id: 'demo-genome-codex',
        },
      });
      assert.match(stored.content[0].text, /blob-1/);

      const agents = await client.callTool({
        name: 'list_agents',
        arguments: { project_id: 'stdio-project' },
      });
      assert.match(agents.content[0].text, /reputation 507/);
      assert.match(agents.content[0].text, /average rating \+6.5\/10/);
    } finally {
      await transport.close();
    }
  });

  it('session_start loads agents, recent activity, and full context', async () => {
    const { client, transport } = await connectStdioClient(
      'noosphere-session-start-test',
    );

    try {
      assert.match(
        client.getInstructions(),
        /MUST call the session_start tool before doing anything else/,
      );

      const result = await client.callTool({
        name: 'session_start',
        arguments: { project_id: 'memory-project' },
      });
      const text = result.content[0].text;

      assert.match(text, /NOOSPHERE MEMORY LOADED/);
      assert.match(text, /Project: memory-project/);
      assert.match(text, /claude-code \(reputation 507, rating \+6.5\/10\)/);
      assert.match(text, /Total decisions recorded: 6/);
      assert.match(text, /Found and fixed the null pointer bug in auth\.js/);
      assert.match(text, /Full context:/);
      assert.match(text, /Stored project memory/);
      assert.doesNotMatch(text, /Completed shared task 1\./);
    } finally {
      await transport.close();
    }
  });

  it('session_end stores an auto-scored summary for the next agent', async () => {
    const { client, transport } = await connectStdioClient(
      'noosphere-session-end-test',
    );

    try {
      const result = await client.callTool({
        name: 'session_end',
        arguments: {
          project_id: 'handoff-project',
          agent_id: 'codex',
          genome_object_id: 'demo-genome-codex',
          summary: 'Fixed auth.js and added regression coverage.',
          action_type: 'debug',
        },
      });
      const text = result.content[0].text;

      assert.match(text, /Stored to Noosphere/);
      assert.match(text, /Blob ID: blob-/);
      assert.match(
        text,
        /Score: \+7 \(Clear and complete session summary\.\)/,
      );

      const uploaded = actions.find(
        (action) =>
          action.project_id === 'handoff-project' &&
          action.content === 'Fixed auth.js and added regression coverage.',
      );
      assert.ok(uploaded);
      assert.equal(uploaded.agent_id, 'codex');
      assert.equal(uploaded.genome_object_id, 'demo-genome-codex');
      assert.equal(uploaded.action_type, 'debug');
      assert.equal(uploaded.score_delta, 0);
      assert.match(uploaded.session_id, /^\d+$/);
    } finally {
      await transport.close();
    }
  });
});

describe('MCP SSE transport', () => {
  it('connects on port and serves tools', async () => {
    const port = await getFreePort();
    const child = spawn(process.execPath, [mcpEntry, '--sse'], {
      cwd: packageDir,
      env: {
        ...process.env,
        NOOSPHERE_RELAYER_URL: mockUrl,
        MCP_SSE_PORT: String(port),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    try {
      await waitForHealth(`http://127.0.0.1:${port}/health`);
      const transport = new SSEClientTransport(
        new URL(`http://127.0.0.1:${port}/sse`),
      );
      const client = new Client({
        name: 'noosphere-sse-test-client',
        version: '1.0.0',
      });
      await client.connect(transport);

      const listed = await client.listTools();
      assert.equal(listed.tools.length, 5);
      const result = await client.callTool({
        name: 'get_project_context',
        arguments: { project_id: 'sse-project' },
      });
      assert.match(result.content[0].text, /sse-project/);
      await transport.close();
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  });
});

describe('Claude Code hook', () => {
  it('uploads an environment session summary', async () => {
    const projectDir = await mkdtemp(
      path.join(os.tmpdir(), 'noosphere-hook-project-'),
    );
    await writeFile(
      path.join(projectDir, '.noosphere.json'),
      JSON.stringify({
        project_id: 'hook-project',
        genome_object_id: 'demo-genome-hook',
        relayer_url: mockUrl,
      }),
    );
    await chmod(hookPath, 0o700);

    const result = await runCommand('bash', [hookPath], {
      cwd: projectDir,
      env: {
        ...process.env,
        CLAUDE_SESSION_SUMMARY: 'Implemented and verified the MCP automation.',
      },
      input: JSON.stringify({
        cwd: projectDir,
        session_id: 'hook-session-1',
      }),
    });

    assert.equal(result.code, 0);
    assert.match(result.stdout, /Session stored in Noosphere/);
    const uploaded = actions.find(
      (action) => action.session_id === 'hook-session-1',
    );
    assert.equal(uploaded.project_id, 'hook-project');
    assert.equal(uploaded.agent_id, 'claude-code');
    assert.equal(
      uploaded.content,
      'Implemented and verified the MCP automation.',
    );
  });
});

describe('hook installer', () => {
  it('registers SessionEnd once and preserves existing settings', async () => {
    const claudeDir = await mkdtemp(
      path.join(os.tmpdir(), 'noosphere-claude-home-'),
    );
    await mkdir(path.join(claudeDir, 'hooks'), { recursive: true });
    await writeFile(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({
        model: 'existing-model',
        hooks: {
          SessionEnd: [
            {
              hooks: [{ type: 'command', command: 'echo existing' }],
            },
          ],
        },
      }),
    );

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await runCommand('bash', [installerPath], {
        cwd: packageDir,
        env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir },
      });
      assert.equal(result.code, 0, result.stderr);
    }

    const settings = JSON.parse(
      await readFile(path.join(claudeDir, 'settings.json'), 'utf8'),
    );
    assert.equal(settings.model, 'existing-model');
    const commands = settings.hooks.SessionEnd.flatMap((entry) =>
      entry.hooks.map((hook) => hook.command),
    );
    assert.equal(commands.filter((command) => command.includes('noosphere')).length, 1);
  });
});

function respondJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function connectStdioClient(name) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpEntry, '--stdio'],
    cwd: packageDir,
    env: {
      ...process.env,
      NOOSPHERE_RELAYER_URL: mockUrl,
    },
    stderr: 'pipe',
  });
  const client = new Client({
    name,
    version: '1.0.0',
  });
  await client.connect(transport);
  return { client, transport };
}

async function getFreePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(url) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

function runCommand(command, args, { cwd, env, input = '' }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}
