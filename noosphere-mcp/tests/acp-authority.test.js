import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import {
  RECONCILIATION_POLICY_VERSION,
  SYNC_PROTOCOL_VERSION,
} from '@noosphere/acp-protocol';
import { RemoteStateClient } from '../continuity/acp/remote-client.js';
import { approveOrigin, secureRelayerFetch } from '../continuity/relayer-authority.js';
import { syncDependencies } from '../continuity/index.js';

const INDEX_ID = `sha256:${'0'.repeat(64)}`;
const TOKEN = 'SECRET-TOKEN-abc123';
const tmpDirs = [];

async function tmp(prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(tmpDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

// A terminal network fetch spy. Records every call; returns a valid
// /v1/acp/capabilities body so the client proceeds past the first request.
function makeNetSpy() {
  const spy = async (url, options) => {
    spy.calls.push({ url, options, authorization: options?.headers?.authorization, redirect: options?.redirect });
    const body = JSON.stringify({
      sync_protocol_version: SYNC_PROTOCOL_VERSION,
      reconciliation_policy_version: RECONCILIATION_POLICY_VERSION,
      relayer_index_id: INDEX_ID,
    });
    return new Response(body, { status: 200, headers: { 'x-relayer-index-id': INDEX_ID } });
  };
  spy.calls = [];
  return spy;
}

// Production boundary (secureRelayerFetch) with only the approved-origin store
// location (env) and the terminal socket (fetchImpl) injected for the test.
// This is exactly the adapter the production ACP path uses, minus real network.
function securedAdapter(env, netSpy) {
  return (url, options) => secureRelayerFetch(url, options, { env, fetchImpl: netSpy });
}

function acpClient(baseUrl, env, netSpy) {
  // token: null — production never gives the ACP client the credential.
  return new RemoteStateClient({ baseUrl, token: null, fetchImpl: securedAdapter(env, netSpy) });
}

describe('SEC-01 — ACP exact-state client routes through the authority boundary', () => {
  let env;
  let net;

  beforeEach(async () => {
    env = { NOOSPHERE_HOME: await tmp('sec01-home-'), NOOSPHERE_API_TOKEN: TOKEN };
    net = makeNetSpy();
  });

  it('unapproved HTTP origin: refused before network I/O, no token, no request', async () => {
    const client = acpClient('http://attacker.evil', env, net);
    await assert.rejects(client.capabilities(), (err) => {
      assert.equal(err.name, 'RemoteStateError');
      assert.equal(err.cause?.code, 'insecure-relayer-scheme');
      return true;
    });
    assert.equal(net.calls.length, 0, 'no network call must be made');
  });

  it('unapproved HTTPS origin: refused before network I/O, no token, no request', async () => {
    const client = acpClient('https://attacker.evil', env, net);
    await assert.rejects(client.capabilities(), (err) => {
      assert.equal(err.name, 'RemoteStateError');
      assert.equal(err.cause?.code, 'unapproved-relayer-origin');
      return true;
    });
    assert.equal(net.calls.length, 0, 'no network call must be made');
  });

  it('unapproved private/link-local IP: refused before network I/O', async () => {
    const client = acpClient('https://169.254.169.254', env, net);
    await assert.rejects(client.capabilities(), (err) => {
      // https private IP is refused as unapproved (never contacted).
      assert.equal(err.cause?.code, 'unapproved-relayer-origin');
      return true;
    });
    assert.equal(net.calls.length, 0);
  });

  it('approved HTTPS origin: request allowed, token attached exactly once, redirect rejected', async () => {
    await approveOrigin('https://relay.example', env);
    const client = acpClient('https://relay.example', env, net);
    await client.capabilities();
    assert.equal(net.calls.length, 1);
    const call = net.calls[0];
    assert.equal(call.url, 'https://relay.example/v1/acp/capabilities');
    assert.equal(call.authorization, `Bearer ${TOKEN}`, 'token attached by the secured fetch layer');
    assert.equal(call.redirect, 'error', 'credentialed redirects must be rejected');
    // Exactly one Authorization header, not duplicated by the client.
    assert.equal(
      Object.keys(call.options.headers).filter((k) => k.toLowerCase() === 'authorization').length,
      1,
    );
  });

  it('loopback origin over plain HTTP: existing documented behavior preserved (allowed, token attached)', async () => {
    // env has no approvals; loopback needs none per the SEC-01 policy.
    const client = acpClient('http://127.0.0.1:8787', env, net);
    await client.capabilities();
    assert.equal(net.calls.length, 1);
    assert.equal(net.calls[0].authorization, `Bearer ${TOKEN}`);
    assert.equal(net.calls[0].redirect, 'error');
  });

  it('IPv6 loopback: allowed, token attached', async () => {
    const client = acpClient('http://[::1]:8787', env, net);
    await client.capabilities();
    assert.equal(net.calls.length, 1);
    assert.equal(net.calls[0].authorization, `Bearer ${TOKEN}`);
  });
});

describe('SEC-01 — production wiring cannot bypass the gate', () => {
  const saved = {};

  beforeEach(() => {
    saved.home = process.env.NOOSPHERE_HOME;
    saved.token = process.env.NOOSPHERE_API_TOKEN;
  });

  after(() => {
    if (saved.home === undefined) delete process.env.NOOSPHERE_HOME;
    else process.env.NOOSPHERE_HOME = saved.home;
    if (saved.token === undefined) delete process.env.NOOSPHERE_API_TOKEN;
    else process.env.NOOSPHERE_API_TOKEN = saved.token;
  });

  it('syncDependencies injects the secured adapter and never hands the token to the client', async () => {
    const home = await tmp('sec01-prod-home-'); // no approvals
    const root = await tmp('sec01-prod-root-'); // empty → readSyncMetadata returns defaults
    process.env.NOOSPHERE_HOME = home;
    process.env.NOOSPHERE_API_TOKEN = TOKEN;

    const deps = await syncDependencies(root, { relayer_url: 'https://attacker.evil' });

    // The client never owns the credential.
    assert.equal(deps.client.token, null);
    // It is not the raw global fetch.
    assert.notEqual(deps.client.fetchImpl, fetch);

    // The injected adapter enforces the authority: a repository-chosen origin is
    // refused before any network I/O (resolveRelayerAuthority throws first), so
    // activateProject's automatic retryExactUploads/discoverExactState — the only
    // callers, both routed through syncDependencies — cannot exfiltrate the token.
    await assert.rejects(
      deps.client.fetchImpl('https://attacker.evil/v1/acp/capabilities', {}),
      (err) => {
        assert.equal(err.code, 'unapproved-relayer-origin');
        return true;
      },
    );
  });
});
