import os from 'node:os';
import path from 'node:path';

import { atomicOwnerOnlyWrite, readOwnerOnlyFile } from './secure-fs.js';

// Trust boundary for the relayer credential (NOOSPHERE_API_TOKEN).
//
// A cloned repository can ship a tracked .noosphere/config.json (or .noosphere.json)
// that selects an arbitrary relayer_url. The bearer token must therefore never be
// attached to an origin the repository chose. The token is only sent to:
//   - a loopback origin (the user's own local relayer), or
//   - an origin the owner explicitly approved in owner-only global configuration.
// Non-loopback origins must use HTTPS, must not be a private/link-local literal IP
// unless approved, and unapproved non-loopback origins are refused entirely (no
// connection, no token) so the request cannot even reach an attacker server.

export class RelayerAuthorityError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'RelayerAuthorityError';
  }
}

export function approvedOriginsPath(env = process.env) {
  const home = env.NOOSPHERE_HOME || path.join(os.homedir(), '.noosphere');
  return path.join(home, 'approved-relayers.json');
}

// Canonical origin: lowercase scheme + host, default ports removed. The WHATWG URL
// parser already lowercases the host, applies IDNA/punycode, strips default ports in
// `.origin`, and brackets IPv6 literals.
export function normalizeOrigin(input) {
  let url;
  try {
    url = new URL(String(input));
  } catch {
    throw new RelayerAuthorityError('invalid-relayer-url', `relayer URL is not a valid URL: ${input}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RelayerAuthorityError('invalid-relayer-scheme', `relayer URL scheme must be http or https: ${input}`);
  }
  if (url.username || url.password) {
    throw new RelayerAuthorityError('relayer-url-userinfo', 'relayer URL must not embed credentials');
  }
  return { origin: url.origin, scheme: url.protocol, host: url.hostname };
}

// Classifies a URL host literal. DNS names are 'public' (they cannot be classified
// without resolving, which is a documented residual limitation).
export function classifyHost(host) {
  const h = String(host).toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return 'loopback';
  const v4 = parseIpv4(h);
  if (v4) return classifyIpv4(v4);
  const mapped = parseIpv4MappedV6(h);
  if (mapped) return classifyIpv4(mapped);
  const v6 = parseIpv6(h);
  if (v6) return classifyIpv6(h);
  return 'public';
}

function parseIpv4(host) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  if (octets.some((n) => n > 255)) return null;
  return octets;
}

function parseIpv4MappedV6(host) {
  const match = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
  return match ? parseIpv4(match[1]) : null;
}

function parseIpv6(host) {
  // Coarse acceptance: hex groups separated by ':' with optional '::'. Enough to
  // recognize a literal so it is never mistaken for a DNS name.
  return /^[0-9a-f:]+$/.test(host) && host.includes(':') ? host : null;
}

function classifyIpv4([a, b]) {
  if (a === 127) return 'loopback';
  if (a === 0) return 'private';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 169 && b === 254) return 'private'; // link-local
  return 'public';
}

function classifyIpv6(host) {
  const h = host.toLowerCase();
  if (h === '::1') return 'loopback';
  if (h === '::' || h === '::0') return 'private';
  if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) return 'private'; // fe80::/10
  if (h.startsWith('fc') || h.startsWith('fd')) return 'private'; // fc00::/7 unique-local
  return 'public';
}

export async function loadApprovedOrigins(env = process.env, secureFileOptions = {}) {
  const raw = await readOwnerOnlyFile(approvedOriginsPath(env), secureFileOptions).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (raw === null) return new Set();
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new RelayerAuthorityError('approved-store-corrupt', 'approved relayer store is not valid JSON');
  }
  const origins = Array.isArray(parsed?.approved_origins) ? parsed.approved_origins : [];
  return new Set(origins.map((value) => {
    try {
      return normalizeOrigin(value).origin;
    } catch {
      return null;
    }
  }).filter(Boolean));
}

export async function approveOrigin(relayerUrl, env = process.env, secureFileOptions = {}) {
  const { origin, scheme, host } = normalizeOrigin(relayerUrl);
  if (classifyHost(host) !== 'loopback' && scheme !== 'https:') {
    throw new RelayerAuthorityError('insecure-relayer-scheme', 'only HTTPS origins can be approved (loopback excepted)');
  }
  const file = approvedOriginsPath(env);
  const approved = await loadApprovedOrigins(env, secureFileOptions);
  approved.add(origin);
  await atomicOwnerOnlyWrite(
    file,
    `${JSON.stringify({ version: 1, approved_origins: [...approved].sort() }, null, 2)}\n`,
    secureFileOptions,
  );
  return origin;
}

// Single credentialed fetch path for every relayer request. Refuses unapproved
// origins before any network activity, attaches the token only to an approved
// origin, and rejects redirects (which could change origin) via redirect:'error'.
export async function secureRelayerFetch(url, options = {}, { env = process.env, fetchImpl = fetch } = {}) {
  const authority = await resolveRelayerAuthority(url, env);
  const headers = { ...(options.headers || {}) };
  const token = env.NOOSPHERE_API_TOKEN;
  if (authority.authenticate && token) {
    headers.authorization = `Bearer ${token}`;
  }
  try {
    return await fetchImpl(url, { ...options, headers, redirect: 'error' });
  } catch (error) {
    // Authority refusals are thrown above this, so only transport failures
    // reach here and only they are relabelled.
    throw describeRelayerFailure(error, authority.origin);
  }
}

// Node answers every transport failure with the same bare `fetch failed`
// TypeError and hides the reason in `cause`: ECONNREFUSED, a DNS miss, a TLS
// error and a refused redirect are indistinguishable in the message. Twenty-one
// of those reached a manager log saying nothing about what could not be reached
// or why, and the installer had grown its own private unwrapping to compensate.
//
// The cause is the part worth reading, so it goes in the message, next to the
// origin the request was actually for.
function describeRelayerFailure(error, origin) {
  const detail = error?.cause?.code
    ?? error?.cause?.message
    ?? error?.message
    ?? 'unknown error';
  const message = `relayer request to ${origin} failed: ${detail}`;
  // A TypeError's message is writable, so the original error keeps its class,
  // its cause and its stack — callers that check for one still see one. A
  // DOMException's is not (AbortSignal.timeout rejects with one), so that path
  // gets a wrapper carrying the original as its cause.
  try {
    error.message = message;
    if (error.message === message) return error;
  } catch {
    // Fall through to the wrapper below.
  }
  return Object.assign(new Error(message, { cause: error }), { name: error?.name ?? 'Error' });
}

// The single decision point. Returns { origin, authenticate } when the request may
// proceed, or throws RelayerAuthorityError when it must be refused.
export async function resolveRelayerAuthority(relayerUrl, env = process.env) {
  const { origin, scheme, host } = normalizeOrigin(relayerUrl);
  const hostClass = classifyHost(host);

  if (hostClass === 'loopback') {
    return { origin, authenticate: true, hostClass };
  }
  if (scheme !== 'https:') {
    throw new RelayerAuthorityError('insecure-relayer-scheme',
      `refusing to use a non-HTTPS remote relayer (${origin}); loopback or HTTPS is required`);
  }
  const approved = await loadApprovedOrigins(env);
  if (!approved.has(origin)) {
    throw new RelayerAuthorityError('unapproved-relayer-origin',
      [
        `refusing to contact an unapproved relayer origin: ${origin}`,
        'The origin came from configuration and is not owner-approved, so no request',
        'is sent and the API token is withheld.',
        '',
        'If you trust this origin, approve it once:',
        `  noosphere approve-relayer ${origin}`,
      ].join('\n'));
  }
  return { origin, authenticate: true, hostClass };
}
