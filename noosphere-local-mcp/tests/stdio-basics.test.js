import assert from 'node:assert/strict';
import { once } from 'node:events';
import { describe, it } from 'node:test';

import { LocalOwnerIdentity, localOwnerScope } from '../src/local-identity.js';
import { createLocalStdioServer } from '../src/stdio-server.js';
import { spawnBin, startStdioClient, structured, temporaryStateFile } from './harness.js';

describe('Local single-user identity', () => {
  it('is deterministic, namespaced, and within the owner-scope bound', () => {
    const a = new LocalOwnerIdentity();
    const b = new LocalOwnerIdentity();
    assert.equal(a.ownerScope, b.ownerScope, 'the fixed principal yields a stable scope');
    assert.match(a.ownerScope, /^local:[0-9a-f]{32}$/, 'namespaced local scope, disjoint from remote issuer|subject scopes');
    assert.ok(a.ownerScope.length >= 3 && a.ownerScope.length <= 512);
    assert.equal(localOwnerScope(), a.ownerScope);
  });

  it('binds the STDIO server to exactly the fixed local scope', () => {
    // Construction does not touch stdin/stdout (the transport only reads on start).
    const server = createLocalStdioServer();
    assert.equal(server.ownerScope, localOwnerScope());
  });
});

// These two write, so they run against an isolated store rather than the CLI's
// real one under the owner's home directory.
describe('Local STDIO single-user semantics', () => {
  it('ignores any ownerScope-looking field in tool input (identity cannot be spoofed by arguments)', async () => {
    const s = await startStdioClient({ stateFile: await temporaryStateFile() });
    try {
      // An injected ownerScope is inert: the server derives the owner from the
      // fixed local identity, never from arguments. The project is created and
      // remains retrievable by the same single local owner.
      const created = structured(await s.client.callTool({ name: 'create_project', arguments: { name: 'Local Only', ownerScope: 'local:deadbeef', owner_scope: 'local:evil' } }));
      const got = structured(await s.client.callTool({ name: 'get_project', arguments: { project_id: created.project.id } }));
      assert.equal(got.project.id, created.project.id);
      assert.equal(got.project.name, 'Local Only');
    } finally {
      await s.close();
    }
  });

  it('marks recalled content as untrusted persisted data over STDIO', async () => {
    const s = await startStdioClient({ stateFile: await temporaryStateFile() });
    try {
      const project = structured(await s.client.callTool({ name: 'create_project', arguments: { name: 'Trust Check' } })).project;
      const latest = structured(await s.client.callTool({ name: 'get_latest_checkpoint', arguments: { project_id: project.id } }));
      assert.equal(latest.content_trust, 'untrusted-persisted-data');
    } finally {
      await s.close();
    }
  });
});

// Deterministic readiness gate: drive a real MCP `initialize` over the child's
// stdio and resolve on its first stdout response. This proves the server is
// fully up (and its lifecycle handlers registered) before we signal it, so the
// shutdown assertions never race process startup.
function whenReady(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not become ready within 5s')), 5000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '0' } } })}\n`);
  });
}

function whenExit(child, label) {
  return Promise.race([
    once(child, 'exit'),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}: did not exit within 5s (possible hang / leaked handle)`)), 5000)),
  ]);
}

describe('Local STDIO process lifecycle', () => {
  it('exits cleanly when the host closes stdin — no hang, no leaked handles', async () => {
    const child = spawnBin();
    await whenReady(child);
    child.stdin.end();
    const [code, signal] = await whenExit(child, 'stdin-close');
    assert.equal(signal, null, 'exited on its own, not via a kill signal');
    assert.equal(code, 0, 'clean exit code');
  });

  it('exits cleanly on SIGTERM', async () => {
    const child = spawnBin();
    await whenReady(child);
    child.kill('SIGTERM');
    const [code] = await whenExit(child, 'SIGTERM');
    assert.equal(code, 0, 'graceful shutdown exit code on SIGTERM');
  });
});
