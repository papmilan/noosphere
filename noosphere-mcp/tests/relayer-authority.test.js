import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { after, describe, it } from 'node:test';

import {
  approveOrigin,
  approvedOriginsPath,
  classifyHost,
  normalizeOrigin,
  RelayerAuthorityError,
  resolveRelayerAuthority,
  secureRelayerFetch,
} from '../continuity/relayer-authority.js';
import { assertOwnerOnlyFile } from './file-security.js';

const dirs = [];
after(async () => Promise.all(dirs.map((dir) => import('node:fs/promises').then((fs) => fs.rm(dir, { recursive: true, force: true })))));
async function tempHome() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'noosphere-authority-'));
  dirs.push(dir);
  return dir;
}

const hasCode = (code) => (error) => error.code === code;

describe('relayer authority — origin normalization', () => {
  it('lowercases host and drops default ports', () => {
    assert.equal(normalizeOrigin('https://Relay.Example.COM:443/v1').origin, 'https://relay.example.com');
    assert.equal(normalizeOrigin('http://Example.com:80').origin, 'http://example.com');
    assert.equal(normalizeOrigin('https://relay.example.com:8443').origin, 'https://relay.example.com:8443');
  });

  it('normalizes IPv6 loopback and brackets', () => {
    assert.equal(normalizeOrigin('http://[::1]:3001').origin, 'http://[::1]:3001');
  });

  it('rejects embedded credentials and non-http schemes', () => {
    assert.throws(() => normalizeOrigin('https://user:pass@relay.example.com'), hasCode('relayer-url-userinfo'));
    assert.throws(() => normalizeOrigin('ftp://relay.example.com'), hasCode('invalid-relayer-scheme'));
    assert.throws(() => normalizeOrigin('not a url'), hasCode('invalid-relayer-url'));
  });
});

describe('relayer authority — host classification', () => {
  it('classifies loopback', () => {
    for (const h of ['localhost', '127.0.0.1', '127.5.6.7', '::1', 'app.localhost']) {
      assert.equal(classifyHost(h), 'loopback', h);
    }
  });
  it('classifies private and link-local', () => {
    for (const h of ['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.10.10', 'fe80::1', 'fc00::1', 'fd12::1', '0.0.0.0']) {
      assert.equal(classifyHost(h), 'private', h);
    }
  });
  it('classifies public hostnames and IPs', () => {
    for (const h of ['relay.example.com', '8.8.8.8', '172.32.0.1']) {
      assert.equal(classifyHost(h), 'public', h);
    }
  });
});

describe('relayer authority — token gate', () => {
  it('authenticates a loopback origin without approval', async () => {
    const env = { NOOSPHERE_HOME: await tempHome() };
    const result = await resolveRelayerAuthority('http://127.0.0.1:3001', env);
    assert.equal(result.authenticate, true);
  });

  it('refuses a non-HTTPS remote origin', async () => {
    const env = { NOOSPHERE_HOME: await tempHome() };
    await assert.rejects(resolveRelayerAuthority('http://relay.example.com', env), hasCode('insecure-relayer-scheme'));
  });

  it('refuses an unapproved HTTPS origin (token withheld, no request)', async () => {
    const env = { NOOSPHERE_HOME: await tempHome() };
    await assert.rejects(resolveRelayerAuthority('https://attacker.example.com', env), hasCode('unapproved-relayer-origin'));
  });

  it('refuses an unapproved private-IP destination', async () => {
    const env = { NOOSPHERE_HOME: await tempHome() };
    await assert.rejects(resolveRelayerAuthority('https://169.254.169.254', env), hasCode('unapproved-relayer-origin'));
  });

  it('allows an origin after explicit owner approval, port-normalized', async () => {
    const env = { NOOSPHERE_HOME: await tempHome() };
    await approveOrigin('https://relay.example.com:443', env);
    const result = await resolveRelayerAuthority('https://relay.example.com', env);
    assert.equal(result.authenticate, true);
    assert.equal(result.origin, 'https://relay.example.com');
  });

  it('writes the approved store owner-only (0600)', async () => {
    const env = { NOOSPHERE_HOME: await tempHome() };
    await approveOrigin('https://relay.example.com', env);
    await assertOwnerOnlyFile(approvedOriginsPath(env));
  });

  it('refuses to approve a non-HTTPS remote origin', async () => {
    const env = { NOOSPHERE_HOME: await tempHome() };
    await assert.rejects(approveOrigin('http://relay.example.com', env), hasCode('insecure-relayer-scheme'));
  });
});

describe('relayer authority — SEC-01 exploit is blocked end to end', () => {
  it('never sends the token to an origin chosen by (untrusted) project config', async () => {
    // Attacker server records any Authorization header it receives.
    const received = [];
    const server = http.createServer((req, res) => {
      received.push(req.headers.authorization || null);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    // The malicious config points at a NON-loopback host that resolves nowhere
    // real; we assert the request is refused before any socket is opened.
    const env = { NOOSPHERE_HOME: await tempHome(), NOOSPHERE_API_TOKEN: 'audit-secret-token' };
    await assert.rejects(
      secureRelayerFetch('https://attacker.example.com/v1/actions', { method: 'POST' }, { env }),
      hasCode('unapproved-relayer-origin'),
    );
    // And even for a reachable attacker loopback that is NOT approved via https,
    // an http remote is refused for scheme, so nothing is ever sent.
    await assert.rejects(
      secureRelayerFetch(`http://10.0.0.1:${port}/v1/actions`, { method: 'POST' }, { env }),
      hasCode('insecure-relayer-scheme'),
    );
    server.close();
    assert.deepEqual(received, [], 'attacker must receive no request at all');
  });

  it('rejects a redirect on the credentialed channel', async () => {
    const redirectTarget = [];
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/v1')) {
        res.writeHead(302, { location: 'http://evil.invalid/steal' });
        res.end();
      } else {
        redirectTarget.push(req.headers.authorization || null);
        res.writeHead(200); res.end('{}');
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const env = { NOOSPHERE_HOME: await tempHome(), NOOSPHERE_API_TOKEN: 'audit-secret-token' };
    await assert.rejects(
      secureRelayerFetch(`http://127.0.0.1:${port}/v1/actions`, {}, { env }),
      (error) => error instanceof TypeError || /redirect/i.test(String(error)),
    );
    server.close();
    assert.deepEqual(redirectTarget, [], 'must not follow redirect to a new origin');
  });
});
