import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { clock, startAcceptance } from './harness.js';
import { RawJsonRpcClient } from './raw-client.js';

const AT = '2026-07-20T10:00:00.000Z';
// The OIDC verifier validates exp/nbf against the real system clock — jose's
// jwtVerify takes no injected `now`, and the harness clock only drives the
// service's record timestamps, not token validity. So expired / not-yet-valid
// tokens must be built relative to real time, or the nbf case would pass only
// because the token also happens to be expired at wall-clock run time.
const nowSec = () => Math.floor(Date.now() / 1000);

// Exact HTTP status matters here, so every case goes through the raw client and
// inspects the transport response directly. Each attempt is a fresh initialize
// POST — authentication is enforced before any session or body handling.
describe('Authentication / OIDC failures return 401 (raw JSON-RPC client)', () => {
  let h;
  before(async () => { h = await startAcceptance({ now: clock(AT) }); });
  after(async () => { await h.close(); });

  async function attempt(sendOpts) {
    const raw = new RawJsonRpcClient({ url: h.mcpUrl, token: 'unused' });
    return raw.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } }, sendOpts);
  }

  it('missing bearer token → 401 with WWW-Authenticate', async () => {
    const r = await attempt({ omitAuth: true });
    assert.equal(r.status, 401);
    assert.match(r.headers['www-authenticate'] || '', /Bearer resource_metadata=/);
  });

  it('malformed bearer token → 401', async () => {
    const r = await attempt({ token: 'not-a-jwt' });
    assert.equal(r.status, 401);
  });

  it('expired token → 401', async () => {
    const token = await h.token({ sub: 'exp', exp: nowSec() - 3600 });
    assert.equal((await attempt({ token })).status, 401);
  });

  it('not-yet-valid (nbf in the future) token → 401', async () => {
    const token = await h.token({ sub: 'nbf', nbf: nowSec() + 3600, exp: nowSec() + 7200 });
    assert.equal((await attempt({ token })).status, 401);
  });

  it('wrong issuer → 401', async () => {
    const token = await h.token({ sub: 'iss', iss: 'https://evil.example/' });
    assert.equal((await attempt({ token })).status, 401);
  });

  it('wrong audience → 401', async () => {
    const token = await h.token({ sub: 'aud', aud: 'https://wrong.example/resource' });
    assert.equal((await attempt({ token })).status, 401);
  });

  it('a correctly signed token for this issuer/audience is accepted (200)', async () => {
    const token = await h.token({ sub: 'ok' });
    assert.equal((await attempt({ token })).status, 200);
  });
});
