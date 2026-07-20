import { createHash } from 'node:crypto';

// Local STDIO mode is explicitly single-user: there is no authentication and
// exactly one owner. `LocalOwnerIdentity` produces a fixed, deterministic owner
// scope for that single user.
//
// Security properties:
//   - The scope is a constant derived only from a fixed principal — never from,
//     or influenced by, tool input. A caller therefore cannot spoof a different
//     identity through arguments (and the closed tool schemas reject any stray
//     `ownerScope` field as invalid-argument regardless).
//   - It is namespaced `local:` so it can never collide with a remote
//     OIDC-derived scope (`issuer:...|subject:...`), keeping the local and
//     remote identity spaces disjoint. This does NOT weaken the remote model:
//     the remote server still requires a verified OIDC identity and never
//     accepts a `local:` scope.
export const LOCAL_PRINCIPAL = 'noosphere-local-single-user';

export class LocalOwnerIdentity {
  #ownerScope;

  constructor(principal = LOCAL_PRINCIPAL) {
    if (typeof principal !== 'string' || principal.length === 0) throw new Error('local-identity-requires-principal');
    // 38 chars: within the repository's 3..512 owner-scope bound.
    this.#ownerScope = `local:${createHash('sha256').update(principal).digest('hex').slice(0, 32)}`;
  }

  get ownerScope() { return this.#ownerScope; }
}

export function localOwnerScope(principal = LOCAL_PRINCIPAL) {
  return new LocalOwnerIdentity(principal).ownerScope;
}
