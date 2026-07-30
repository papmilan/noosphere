import { normalizeOrigin } from './relayer-origins.js';

// SEC-01b trust boundary: same-origin redirect enforcement.
//
// SEC-01 (`relayer-origins.js`) guarantees the credential-bearing MemWal client
// is only constructed for an owner-approved origin. It does not constrain what
// happens AFTER the first request: the SDK calls the global `fetch` with the
// default `redirect: 'follow'`, and undici forwards custom `x-*` headers and
// the request body across 307/308 redirects. An approved-then-compromised
// relayer could therefore answer with a cross-origin redirect and replay the
// request-scoped signature headers and the payload (memory text, recall query)
// against an origin the owner never approved.
//
// This guard closes that: every request aimed at a guarded (approved) origin is
// sent with `redirect: 'manual'`, and ANY redirect status is refused before a
// follow-up request exists to send. Same-origin redirects are refused too, not
// re-followed: the request signature covers the exact path and query, so a
// redirected signed request is unverifiable at its destination by design — a
// redirecting relayer is malfunctioning or hostile either way. Requests to any
// other origin (embeddings API, Walrus aggregator, Sui RPC) are passed through
// byte-for-byte untouched; this module never widens or narrows SEC-01 origin
// approval itself.

export class RelayerRedirectError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.code = code;
    this.name = 'RelayerRedirectError';
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// One process-wide wrapper over `globalThis.fetch`, guarding a set of
// normalized origins. Installing is idempotent per origin; the returned
// uninstaller removes only its own origin and unwraps `fetch` when the last
// origin is removed (test isolation — production never uninstalls).
const guardedOrigins = new Map(); // normalized origin -> install count
let originalFetch = null;

export function installRelayerFetchGuard(origin) {
  const guarded = normalizeOrigin(origin);
  guardedOrigins.set(guarded, (guardedOrigins.get(guarded) ?? 0) + 1);

  if (originalFetch === null) {
    originalFetch = globalThis.fetch;
    globalThis.fetch = guardedFetch;
  }

  let removed = false;
  return function uninstall() {
    if (removed) return;
    removed = true;
    const count = guardedOrigins.get(guarded) ?? 0;
    if (count <= 1) guardedOrigins.delete(guarded);
    else guardedOrigins.set(guarded, count - 1);
    if (guardedOrigins.size === 0 && originalFetch !== null) {
      globalThis.fetch = originalFetch;
      originalFetch = null;
    }
  };
}

async function guardedFetch(input, init) {
  const target = requestOrigin(input);
  if (target === null || !guardedOrigins.has(target)) {
    return originalFetch(input, init);
  }

  // `redirect: 'manual'` makes undici return the 3xx response instead of
  // issuing the follow-up request, so the refusal happens before any bytes can
  // reach the redirect target.
  const response = await originalFetch(input, { ...init, redirect: 'manual' });
  if (REDIRECT_STATUSES.has(response.status)) {
    const location = response.headers.get('location') ?? '';
    let destination = 'an unparseable destination';
    try {
      destination = normalizeOrigin(new URL(location, `${target}/`));
    } catch {
      // Keep the placeholder: the refusal must not depend on the attacker
      // sending a well-formed Location header.
    }
    throw new RelayerRedirectError(
      'relayer-redirect-refused',
      `approved relayer origin ${target} answered ${response.status} redirecting to ${destination}; ` +
        'signed relayer traffic is never re-sent after a redirect (SEC-01b)',
    );
  }
  return response;
}

function requestOrigin(input) {
  try {
    const url = input instanceof Request ? input.url : String(input);
    return normalizeOrigin(url);
  } catch {
    // Non-http(s) or unparseable targets are not relayer traffic; let the
    // underlying fetch produce its own error untouched.
    return null;
  }
}
