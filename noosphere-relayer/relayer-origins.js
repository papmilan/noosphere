import os from 'node:os';
import path from 'node:path';
import { readFileNoFollowSync } from './secure-fs.js';

// SEC-01 trust boundary for the outbound relayer.
//
// The Walrus relayer URL can be set by `MEMWAL_SERVER_URL`, which
// `dotenv/config` loads from a `.env` in the current working directory. A cloned
// or malicious repository can therefore *silently* redirect the credential-
// bearing MemWal client (it is constructed with the owner's private key) to an
// attacker-controlled origin, exfiltrating the key on the first request.
//
// This module makes that impossible: a credential-bearing client may only be
// pointed at an origin that is either (a) a relayer origin shipped in this
// codebase, or (b) explicitly approved by the owner in an owner-only GLOBAL file
// under the home directory (never the project tree, so a clone cannot plant it).
// Non-loopback origins must be HTTPS. Anything else fails closed — the client is
// never constructed, so the token is never sent.

export class RelayerOriginError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.code = code;
    this.name = 'RelayerOriginError';
  }
}

// Owner-only global approval list. Lives under the home directory, so a cloned
// project directory can never introduce an approved origin.
export function approvedOriginsPath(home = os.homedir()) {
  return path.join(home, '.noosphere', 'relayer-origins.json');
}

// Normalize to a canonical scheme://host[:port] origin: lowercase scheme+host,
// default ports (443/80) collapsed, path/query/fragment and userinfo dropped.
// Rejects anything that is not http(s) so credentials can never be aimed at a
// file:, data:, or other non-network scheme.
export function normalizeOrigin(input) {
  let url;
  try {
    url = new URL(String(input));
  } catch {
    throw new RelayerOriginError('relayer-origin-invalid', `not a valid URL: ${input}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new RelayerOriginError('relayer-origin-invalid-scheme', `unsupported scheme: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new RelayerOriginError('relayer-origin-userinfo', 'relayer origin must not embed credentials');
  }
  // url.origin already lowercases the host and collapses default ports for
  // http/https, and brackets IPv6 hosts.
  return url.origin;
}

export function isLoopbackOrigin(input) {
  let hostname;
  try {
    hostname = new URL(String(input)).hostname.toLowerCase();
  } catch {
    return false;
  }
  // WHATWG URL keeps IPv6 brackets in .hostname (e.g. "[::1]"); strip them.
  hostname = hostname.replace(/^\[/, '').replace(/\]$/, '');
  // Match localhost, the 127.0.0.0/8 block, and ::1. Deliberately NOT 0.0.0.0:
  // that is the unspecified address (RFC 1122), not loopback, and is not a
  // legitimate relayer target — dev uses 127.0.0.1/localhost. Excluding it keeps
  // the HTTP-without-approval grant to true loopback only.
  if (hostname === 'localhost' || hostname === '::1') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  return false;
}

// Read the owner-only global approvals. Missing file → no approvals. Malformed
// file → no approvals (fail closed: a broken list never widens trust).
export function loadApprovedOrigins(home = os.homedir()) {
  let raw;
  try {
    raw = readFileNoFollowSync(approvedOriginsPath(home));
  } catch {
    return new Set();
  }
  if (!raw) return new Set();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Set();
  }
  const list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.origins) ? parsed.origins : [];
  const approved = new Set();
  for (const entry of list) {
    try {
      approved.add(normalizeOrigin(entry));
    } catch {
      // Skip unparseable entries rather than trusting them.
    }
  }
  return approved;
}

// The single gate: throw unless `url`'s origin is approved for credential-bearing
// use. Loopback http is allowed (local development). Non-loopback must be HTTPS
// and must be either a shipped built-in origin or in the owner-only global list.
export function assertApprovedRelayerOrigin(
  url,
  { builtinOrigins = [], home = os.homedir(), loadApproved = loadApprovedOrigins } = {},
) {
  const origin = normalizeOrigin(url); // throws on bad scheme / userinfo / parse

  if (isLoopbackOrigin(url)) {
    return origin;
  }

  if (new URL(String(url)).protocol !== 'https:') {
    throw new RelayerOriginError(
      'relayer-origin-insecure',
      `refusing to send credentials to non-HTTPS relayer origin ${origin}`,
    );
  }

  const builtin = new Set();
  for (const b of builtinOrigins) {
    try {
      builtin.add(normalizeOrigin(b));
    } catch {
      // Ignore an unparseable built-in default rather than crash.
    }
  }
  if (builtin.has(origin)) return origin;

  if (loadApproved(home).has(origin)) return origin;

  throw new RelayerOriginError(
    'relayer-origin-not-approved',
    `relayer origin ${origin} is not approved. It was not shipped with Noosphere and is not in `
      + `${approvedOriginsPath(home)}. A tracked project config (e.g. a committed .env setting `
      + `MEMWAL_SERVER_URL) cannot approve an origin. To trust it, add ${origin} to that owner-only `
      + `file (JSON array), then retry. Credentials were NOT sent.`,
  );
}
