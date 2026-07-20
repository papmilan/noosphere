import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { SignJWT, generateKeyPair } from 'jose';

import { OidcVerifier } from '../src/oidc.js';

const ISS = 'https://issuer.example/';
const OTHER_ISS = 'https://evil.example/';
const AUD = 'https://noosphere.example/project-memory';

let priv;
let pub;
let otherPriv;

before(async () => {
  ({ privateKey: priv, publicKey: pub } = await generateKeyPair('RS256'));
  ({ privateKey: otherPriv } = await generateKeyPair('RS256'));
});

function sign(privateKey, { iss = ISS, aud = AUD, sub = 'user-1', scope = 'project.read project.write', exp = '2h' } = {}) {
  return new SignJWT({ scope }).setProtectedHeader({ alg: 'RS256' }).setIssuer(iss).setAudience(aud).setSubject(sub).setIssuedAt().setExpirationTime(exp).sign(privateKey);
}

function verifier(overrides = {}) {
  return new OidcVerifier({ issuers: { [ISS]: pub }, audience: AUD, requiredScopes: ['project.read'], ...overrides });
}

describe('OIDC verifier', () => {
  it('accepts a valid token and derives owner scope from the verified subject', async () => {
    const result = await verifier().verify(await sign(priv, { sub: 'alice' }));
    assert.equal(result.ownerScope, `issuer:${ISS}|subject:alice`);
    assert.equal(result.subject, 'alice');
  });

  it('derives distinct owner scopes for distinct subjects', async () => {
    const v = verifier();
    const a = await v.verify(await sign(priv, { sub: 'alice' }));
    const b = await v.verify(await sign(priv, { sub: 'bob' }));
    assert.notEqual(a.ownerScope, b.ownerScope);
  });

  it('rejects a wrong audience as unauthenticated', async () => {
    await assert.rejects(verifier().verify(await sign(priv, { aud: 'https://someone.else/' })), (e) => e.code === 'unauthenticated');
  });

  it('rejects an unknown issuer as unauthenticated', async () => {
    await assert.rejects(verifier().verify(await sign(otherPriv, { iss: OTHER_ISS })), (e) => e.code === 'unauthenticated');
  });

  it('rejects a forged signature as unauthenticated', async () => {
    // Correct issuer claim, but signed with a key the resolver does not trust.
    await assert.rejects(verifier().verify(await sign(otherPriv, { iss: ISS })), (e) => e.code === 'unauthenticated');
  });

  it('rejects an expired token as unauthenticated', async () => {
    await assert.rejects(verifier().verify(await sign(priv, { exp: '-1m' })), (e) => e.code === 'unauthenticated');
  });

  it('rejects insufficient scope as forbidden', async () => {
    const v = verifier({ requiredScopes: ['project.admin'] });
    await assert.rejects(v.verify(await sign(priv, { scope: 'project.read' })), (e) => e.code === 'forbidden');
  });

  it('rejects a non-string/empty token as unauthenticated', async () => {
    await assert.rejects(verifier().verify(''), (e) => e.code === 'unauthenticated');
    await assert.rejects(verifier().verify(null), (e) => e.code === 'unauthenticated');
  });

  it('refuses to construct a production verifier with test identities enabled', () => {
    assert.throws(() => verifier({ production: true, allowTestIdentities: true }), /production-forbids-test-identities/);
  });

  it('gates the test-identity injector behind the development flag', async () => {
    assert.throws(() => verifier().testIdentity('dev'), (e) => e.code === 'unauthenticated');
    const dev = verifier({ allowTestIdentities: true });
    assert.equal(dev.testIdentity('dev').ownerScope, 'issuer:urn:noosphere:test|subject:dev');
  });

  it('rejects a token signed with a symmetric algorithm as unauthenticated', async () => {
    const secret = new TextEncoder().encode('shared-secret-shared-secret-01234567');
    const hsToken = await new SignJWT({ scope: 'project.read' })
      .setProtectedHeader({ alg: 'HS256' }).setIssuer(ISS).setAudience(AUD).setSubject('mallory').setIssuedAt().setExpirationTime('2h').sign(secret);
    await assert.rejects(verifier().verify(hsToken), (e) => e.code === 'unauthenticated');
  });

  it('derives distinct owner scopes for the same subject under different issuers', async () => {
    const v = new OidcVerifier({ issuers: { [ISS]: pub, [OTHER_ISS]: pub }, audience: AUD, requiredScopes: ['project.read'] });
    const one = await v.verify(await sign(priv, { iss: ISS, sub: 'same' }));
    const two = await v.verify(await sign(priv, { iss: OTHER_ISS, sub: 'same' }));
    assert.notEqual(one.ownerScope, two.ownerScope);
  });

  describe('scp array scope claim', () => {
    const scpToken = (scp) => new SignJWT({ scp }).setProtectedHeader({ alg: 'RS256' }).setIssuer(ISS).setAudience(AUD).setSubject('u').setIssuedAt().setExpirationTime('2h').sign(priv);

    it('accepts an scp array containing the required scopes', async () => {
      const result = await verifier({ requiredScopes: ['project.write'] }).verify(await scpToken(['project.read', 'project.write']));
      assert.deepEqual(result.scopes, ['project.read', 'project.write']);
    });

    it('rejects an scp array missing a required scope as forbidden', async () => {
      await assert.rejects(verifier({ requiredScopes: ['project.admin'] }).verify(await scpToken(['project.read'])), (e) => e.code === 'forbidden');
    });

    it('ignores non-string scp members while honouring valid ones', async () => {
      const result = await verifier({ requiredScopes: ['project.read'] }).verify(await scpToken(['project.read', 123, null]));
      assert.deepEqual(result.scopes, ['project.read']);
    });
  });
});
