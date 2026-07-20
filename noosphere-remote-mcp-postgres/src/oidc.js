import { jwtVerify } from 'jose';

// Accepted signature algorithms: asymmetric JWKS families only. This excludes
// `none` and every symmetric (HS*) algorithm, so a shared secret can never be
// used to forge a token and an attacker cannot downgrade to alg=none.
export const ACCEPTED_ALGORITHMS = Object.freeze([
  'RS256', 'RS384', 'RS512',
  'PS256', 'PS384', 'PS512',
  'ES256', 'ES384', 'ES512',
  'EdDSA',
]);

// Provider-neutral OIDC verifier (ADR 0005). The remote MCP service is an
// OAuth 2.1 protected resource: this validates issuer, audience, signature,
// expiry, and required scopes, then derives an owner scope from the verified
// subject. No caller-supplied owner/subject/token is ever trusted.

export class OidcError extends Error {
  constructor(code) {
    super(code);
    this.name = 'OidcError';
    this.code = code; // 'unauthenticated' | 'forbidden'
  }
}

// owner_scope is derived only from verified claims and matches the core
// owner-scope string shape used everywhere else.
export function deriveOwnerScope(issuer, subject) {
  if (typeof issuer !== 'string' || typeof subject !== 'string' || issuer.length === 0 || subject.length === 0) {
    throw new OidcError('unauthenticated');
  }
  return `issuer:${issuer}|subject:${subject}`;
}

function tokenScopes(claims) {
  if (typeof claims.scope === 'string') return claims.scope.split(' ').filter(Boolean);
  if (Array.isArray(claims.scp)) return claims.scp.filter((s) => typeof s === 'string');
  return [];
}

export class OidcVerifier {
  #issuers;
  #audience;
  #requiredScopes;
  #allowTestIdentities;

  // issuers: { [iss]: keyResolver } where keyResolver is anything jose's
  // jwtVerify accepts (a KeyLike, or a JWKS function from createRemoteJWKSet).
  constructor({ issuers, audience, requiredScopes = [], allowTestIdentities = false, production = false } = {}) {
    // Production must never enable the local test-identity injector.
    if (production && allowTestIdentities) throw new Error('production-forbids-test-identities');
    if (!issuers || typeof issuers !== 'object' || Object.keys(issuers).length === 0) throw new Error('oidc-requires-issuers');
    if (typeof audience !== 'string' || audience.length === 0) throw new Error('oidc-requires-audience');
    this.#issuers = issuers;
    this.#audience = audience;
    this.#requiredScopes = [...requiredScopes];
    this.#allowTestIdentities = allowTestIdentities === true;
  }

  async verify(token) {
    if (typeof token !== 'string' || token.length === 0) throw new OidcError('unauthenticated');

    // Resolve the key material by the token's asserted issuer, but the real
    // trust decision is jose verifying the signature + issuer + audience + exp.
    let unverifiedIssuer;
    try {
      unverifiedIssuer = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')).iss;
    } catch {
      throw new OidcError('unauthenticated');
    }
    const keyResolver = typeof unverifiedIssuer === 'string' ? this.#issuers[unverifiedIssuer] : undefined;
    if (!keyResolver) throw new OidcError('unauthenticated');

    let claims;
    try {
      ({ payload: claims } = await jwtVerify(token, keyResolver, {
        issuer: unverifiedIssuer,
        audience: this.#audience,
        algorithms: ACCEPTED_ALGORITHMS,
      }));
    } catch {
      // Never disclose why (project names / ownership stay hidden).
      throw new OidcError('unauthenticated');
    }

    const scopes = tokenScopes(claims);
    if (!this.#requiredScopes.every((scope) => scopes.includes(scope))) throw new OidcError('forbidden');

    return { ownerScope: deriveOwnerScope(claims.iss, claims.sub), subject: claims.sub, scopes };
  }

  // Development-only shortcut. Hard-fails unless test identities were explicitly
  // enabled; a production verifier can never construct with them enabled.
  testIdentity(subject) {
    if (!this.#allowTestIdentities) throw new OidcError('unauthenticated');
    if (typeof subject !== 'string' || subject.length === 0) throw new OidcError('unauthenticated');
    return { ownerScope: deriveOwnerScope('urn:noosphere:test', subject), subject, scopes: [...this.#requiredScopes] };
  }
}
