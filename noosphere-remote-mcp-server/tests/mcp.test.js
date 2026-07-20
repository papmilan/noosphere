import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { validCheckpoint } from '../../noosphere-remote-mcp/tests/fixtures.js';
import { startServer } from './harness.js';

async function connect(h, tok) {
  const transport = new StreamableHTTPClientTransport(new URL(h.mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${tok}` } } });
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}
const structured = (r) => r.structuredContent;

describe('MCP session over Streamable HTTP', () => {
  let h;
  before(async () => { h = await startServer(); });
  after(async () => { await h.close(); });

  it('initializes and lists the 15 project-memory tools', async () => {
    const { client, transport } = await connect(h, await h.token());
    const { tools } = await client.listTools();
    assert.equal(tools.length, 15);
    assert.ok(tools.find((t) => t.name === 'create_project'));
    assert.ok(tools.every((t) => t.inputSchema && t.inputSchema.type === 'object'));
    await transport.close();
  });

  it('creates, gets, and finds a project through tool calls', async () => {
    const { client, transport } = await connect(h, await h.token({ sub: 'creator' }));
    const created = structured(await client.callTool({ name: 'create_project', arguments: { name: 'Bicycle Repair' } }));
    assert.equal(created.project.normalized_name, 'bicycle repair');
    const got = structured(await client.callTool({ name: 'get_project', arguments: { project_id: created.project.id } }));
    assert.equal(got.project.id, created.project.id);
    // Exact normalized name resolves; a bare substring ('bicycle') is
    // discovery-only and would return 'ambiguous' by the core contract.
    const found = structured(await client.callTool({ name: 'find_projects', arguments: { query: 'Bicycle Repair' } }));
    assert.equal(found.result, 'resolved');
    await transport.close();
  });

  it('replays a retry-safe save_checkpoint with the same idempotency key', async () => {
    const { client, transport } = await connect(h, await h.token({ sub: 'saver' }));
    const project = structured(await client.callTool({ name: 'create_project', arguments: { name: 'Repair' } })).project;
    const session = structured(await client.callTool({ name: 'create_session', arguments: { project_id: project.id, source_client: 'chatgpt' } })).session;
    const checkpoint = validCheckpoint({ id: 'chk_root', project_id: project.id, session_id: session.id });
    const args = { project_id: project.id, session_id: session.id, checkpoint, idempotency_key: 'idem-1' };
    const first = structured(await client.callTool({ name: 'save_checkpoint', arguments: args }));
    const second = structured(await client.callTool({ name: 'save_checkpoint', arguments: args }));
    assert.equal(first.deduplicated, false);
    assert.equal(second.deduplicated, true);
    const resumed = structured(await client.callTool({ name: 'resume_project', arguments: { project_id: project.id } }));
    assert.equal(resumed.latest_checkpoint.id, 'chk_root');
    assert.equal(resumed.content_trust, 'untrusted-persisted-data');
    await transport.close();
  });

  it('returns a tool error for invalid input and unknown tools', async () => {
    const { client, transport } = await connect(h, await h.token());
    const bad = await client.callTool({ name: 'get_project', arguments: { project_id: 'NOT VALID ID' } });
    assert.equal(bad.isError, true);
    assert.equal(bad.structuredContent.error.code, 'invalid-argument');
    await transport.close();
  });

  it('isolates owners: one subject cannot read another subject project', async () => {
    const alice = await connect(h, await h.token({ sub: 'alice' }));
    const bob = await connect(h, await h.token({ sub: 'bob' }));
    const project = structured(await alice.client.callTool({ name: 'create_project', arguments: { name: 'Alice Only' } })).project;
    const cross = await bob.client.callTool({ name: 'get_project', arguments: { project_id: project.id } });
    assert.equal(cross.isError, true);
    assert.equal(cross.structuredContent.error.code, 'not-found');
    await alice.transport.close();
    await bob.transport.close();
  });
});
