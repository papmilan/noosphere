import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assertApprovedRelayerOrigin,
  normalizeOrigin,
  isLoopbackOrigin,
  loadApprovedOrigins,
  approvedOriginsPath,
  RelayerOriginError,
} from '../relayer-origins.js';
import { WalrusMemoryAdapter, WALRUS_NETWORKS } from '../walrus-memory.js';

const BUILTINS = Object.values(WALRUS_NETWORKS).map((n) => n.relayerUrl);

// Fresh temp home per test so the owner-only approval file is isolated.
function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'noos-origin-'));
  return home;
}

function writeApproved(home, origins) {
  fs.mkdirSync(path.join(home, '.noosphere'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(approvedOriginsPath(home), JSON.stringify(origins), { mode: 0o600 });
}

// ---- normalization -------------------------------------------------------

test('normalizeOrigin lowercases host, drops path, and collapses default ports', () => {
  assert.equal(normalizeOrigin('https://Relayer.Example.COM:443/api/x?y=1#z'), 'https://relayer.example.com');
  assert.equal(normalizeOrigin('http://Example.com:80'), 'http://example.com');
  assert.equal(normalizeOrigin('https://example.com:8443'), 'https://example.com:8443');
});

test('normalizeOrigin brackets IPv6 and keeps loopback forms', () => {
  assert.equal(normalizeOrigin('http://[::1]:80/'), 'http://[::1]');
});

const hasCode = (code) => (e) => e instanceof RelayerOriginError && e.code === code;

test('normalizeOrigin rejects non-http(s) schemes and embedded credentials', () => {
  assert.throws(() => normalizeOrigin('file:///etc/passwd'), hasCode('relayer-origin-invalid-scheme'));
  assert.throws(() => normalizeOrigin('javascript:alert(1)'), hasCode('relayer-origin-invalid-scheme'));
  assert.throws(() => normalizeOrigin('https://user:pass@example.com'), hasCode('relayer-origin-userinfo'));
});

test('isLoopbackOrigin recognizes localhost, 127.0.0.0/8, ::1; not private/link-local', () => {
  assert.equal(isLoopbackOrigin('http://localhost:3001'), true);
  assert.equal(isLoopbackOrigin('http://127.0.0.1'), true);
  assert.equal(isLoopbackOrigin('http://127.5.6.7'), true);
  assert.equal(isLoopbackOrigin('http://[::1]'), true);
  assert.equal(isLoopbackOrigin('http://10.0.0.5'), false);
  assert.equal(isLoopbackOrigin('http://169.254.169.254'), false); // link-local
  assert.equal(isLoopbackOrigin('https://relayer.example.com'), false);
});

// ---- approval gate -------------------------------------------------------

test('built-in shipped relayer origins are approved without any config', () => {
  const home = tempHome();
  for (const url of BUILTINS) {
    assert.equal(assertApprovedRelayerOrigin(url, { builtinOrigins: BUILTINS, home }), normalizeOrigin(url));
  }
});

test('an unapproved custom origin fails closed (default-deny)', () => {
  const home = tempHome();
  assert.throws(
    () => assertApprovedRelayerOrigin('https://attacker.evil', { builtinOrigins: BUILTINS, home }),
    (e) => e instanceof RelayerOriginError && e.code === 'relayer-origin-not-approved',
  );
});

test('non-loopback HTTP is refused even if otherwise approved-looking', () => {
  const home = tempHome();
  writeApproved(home, ['http://relayer.example.com']); // approval of an http origin
  assert.throws(
    () => assertApprovedRelayerOrigin('http://relayer.example.com', { builtinOrigins: BUILTINS, home }),
    hasCode('relayer-origin-insecure'),
  );
});

test('loopback HTTP is allowed for local development', () => {
  const home = tempHome();
  assert.equal(
    assertApprovedRelayerOrigin('http://127.0.0.1:3001', { builtinOrigins: BUILTINS, home }),
    'http://127.0.0.1:3001',
  );
});

test('an origin listed in the owner-only global file is approved', () => {
  const home = tempHome();
  writeApproved(home, ['https://my-relayer.example.com']);
  assert.equal(
    assertApprovedRelayerOrigin('https://My-Relayer.Example.com:443/', { builtinOrigins: BUILTINS, home }),
    'https://my-relayer.example.com',
  );
});

test('private and link-local IPs require approval and HTTPS', () => {
  const home = tempHome();
  assert.throws(
    () => assertApprovedRelayerOrigin('https://10.0.0.5', { builtinOrigins: BUILTINS, home }),
    hasCode('relayer-origin-not-approved'),
  );
  assert.throws(
    () => assertApprovedRelayerOrigin('http://169.254.169.254', { builtinOrigins: BUILTINS, home }),
    hasCode('relayer-origin-insecure'),
  );
});

test('approving one origin does not approve a different host (origin change)', () => {
  const home = tempHome();
  writeApproved(home, ['https://relayer-a.example.com']);
  assert.doesNotThrow(() => assertApprovedRelayerOrigin('https://relayer-a.example.com', { builtinOrigins: BUILTINS, home }));
  assert.throws(
    () => assertApprovedRelayerOrigin('https://relayer-b.example.com', { builtinOrigins: BUILTINS, home }),
    hasCode('relayer-origin-not-approved'),
  );
});

test('a malformed approvals file fails closed (nothing approved)', () => {
  const home = tempHome();
  fs.mkdirSync(path.join(home, '.noosphere'), { recursive: true });
  fs.writeFileSync(approvedOriginsPath(home), 'not json', { mode: 0o600 });
  assert.equal(loadApprovedOrigins(home).size, 0);
});

// ---- end-to-end exfiltration regression ----------------------------------

test('REGRESSION: a repo-controlled MEMWAL_SERVER_URL cannot receive the private key', () => {
  const home = tempHome();
  // Simulates `dotenv/config` having loaded a malicious committed .env.
  const env = {
    MEMWAL_NETWORK: 'mainnet',
    MEMWAL_PRIVATE_KEY: 'a'.repeat(64),
    MEMWAL_ACCOUNT_ID: `0x${'b'.repeat(64)}`,
    MEMWAL_SERVER_URL: 'https://attacker.evil/relayer',
  };
  let clientCreated = false;
  const adapter = new WalrusMemoryAdapter(env, {
    home,
    createClient: () => {
      clientCreated = true; // would carry env.MEMWAL_PRIVATE_KEY to attacker.evil
      return {};
    },
  });
  assert.throws(
    () => adapter.getClient(),
    (e) => e.code === 'relayer-origin-not-approved',
  );
  assert.equal(clientCreated, false, 'the credential-bearing client must never be constructed');
});

test('MIGRATION: existing configs on the shipped default relayer keep working', () => {
  const home = tempHome();
  const env = {
    MEMWAL_NETWORK: 'mainnet',
    MEMWAL_PRIVATE_KEY: 'a'.repeat(64),
    MEMWAL_ACCOUNT_ID: `0x${'b'.repeat(64)}`,
    // no MEMWAL_SERVER_URL → shipped default
  };
  let created = false;
  const adapter = new WalrusMemoryAdapter(env, { home, createClient: () => { created = true; return {}; } });
  assert.doesNotThrow(() => adapter.getClient());
  assert.equal(created, true);
});

// ---- F3: adversarial normalization regressions ---------------------------
// Each asserts the authorization outcome (allow vs which deny code), not just
// the normalized string, so a normalization regression that changed trust is
// caught.

const BUILTIN = 'https://relayer.memory.walrus.xyz';

test('adversarial: an explicit default :443 on a built-in still matches (same origin)', () => {
  const home = tempHome();
  assert.equal(
    assertApprovedRelayerOrigin(`${BUILTIN}:443`, { builtinOrigins: BUILTINS, home }),
    BUILTIN,
  );
});

test('adversarial: a trailing-dot FQDN is a DIFFERENT origin and is not approved', () => {
  const home = tempHome();
  assert.equal(normalizeOrigin(`${BUILTIN}.`), `${BUILTIN}.`);
  assert.throws(
    () => assertApprovedRelayerOrigin(`${BUILTIN}.`, { builtinOrigins: BUILTINS, home }),
    hasCode('relayer-origin-not-approved'),
  );
});

test('adversarial: a path/traversal on a built-in does not change the approved origin', () => {
  const home = tempHome();
  assert.equal(normalizeOrigin(`${BUILTIN}/../../evil?x=1#f`), BUILTIN);
  assert.equal(assertApprovedRelayerOrigin(`${BUILTIN}/../../evil`, { builtinOrigins: BUILTINS, home }), BUILTIN);
});

test('adversarial: decimal and hex IPv4 that canonicalize to 127.0.0.1 are loopback', () => {
  const home = tempHome();
  assert.equal(isLoopbackOrigin('http://2130706433'), true); // decimal 127.0.0.1
  assert.equal(isLoopbackOrigin('http://0x7f000001'), true); // hex 127.0.0.1
  assert.equal(assertApprovedRelayerOrigin('http://2130706433', { builtinOrigins: BUILTINS, home }), 'http://127.0.0.1');
  assert.equal(assertApprovedRelayerOrigin('http://0x7f000001', { builtinOrigins: BUILTINS, home }), 'http://127.0.0.1');
});

test('adversarial: IPv4-mapped IPv6 loopback is NOT auto-trusted (requires https+approval)', () => {
  const home = tempHome();
  assert.equal(isLoopbackOrigin('http://[::ffff:127.0.0.1]'), false);
  assert.throws(
    () => assertApprovedRelayerOrigin('http://[::ffff:127.0.0.1]', { builtinOrigins: BUILTINS, home }),
    hasCode('relayer-origin-insecure'),
  );
});

test('adversarial: punycode and a Unicode-confusable host resolve to distinct, unapproved origins', () => {
  const home = tempHome();
  // Cyrillic "а" (U+0430) IDNA-maps to the same punycode as the explicit xn-- form,
  // and neither equals the latin builtin — so a homograph cannot borrow trust.
  assert.equal(normalizeOrigin('https://аpple.com'), 'https://xn--pple-43d.com');
  assert.equal(normalizeOrigin('https://xn--pple-43d.com'), 'https://xn--pple-43d.com');
  assert.throws(
    () => assertApprovedRelayerOrigin('https://аpple.com', { builtinOrigins: BUILTINS, home }),
    hasCode('relayer-origin-not-approved'),
  );
});

test('adversarial: normalization is idempotent (stable under repeated application)', () => {
  for (const u of [`${BUILTIN}:443/x?q#f`, 'http://2130706433', 'https://аpple.com', 'http://[::1]:80']) {
    const once = normalizeOrigin(u);
    assert.equal(normalizeOrigin(once), once, `normalize not stable for ${u}`);
  }
});

test('F2 regression: 0.0.0.0 (unspecified, not loopback) is not auto-trusted over HTTP', () => {
  const home = tempHome();
  assert.equal(isLoopbackOrigin('http://0.0.0.0'), false);
  assert.throws(
    () => assertApprovedRelayerOrigin('http://0.0.0.0', { builtinOrigins: BUILTINS, home }),
    hasCode('relayer-origin-insecure'),
  );
});
