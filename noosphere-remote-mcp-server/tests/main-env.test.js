import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseServerEnv } from '../src/main.js';

const BASE = Object.freeze({
  NOOSPHERE_AUDIENCE: 'https://noosphere.example/project-memory',
  NOOSPHERE_RESOURCE_METADATA_URL: 'https://noosphere.example/.well-known/oauth-protected-resource',
  NOOSPHERE_OIDC_ISSUERS: JSON.stringify([{ iss: 'https://issuer.example/', jwks_uri: 'https://issuer.example/jwks' }]),
});

test('parses a minimal valid non-production (memory) environment', () => {
  const options = parseServerEnv({ ...BASE });
  assert.equal(options.repository, 'memory');
  assert.equal(options.production, false);
  assert.equal(options.port, 8080);
  assert.equal(options.audience, BASE.NOOSPHERE_AUDIENCE);
  assert.deepEqual(options.issuers, [{ iss: 'https://issuer.example/', jwksUri: 'https://issuer.example/jwks' }]);
});

const PROD = Object.freeze({
  ...BASE,
  NOOSPHERE_PRODUCTION: 'true',
  NOOSPHERE_AUTHORIZATION_SERVERS: 'https://issuer.example/',
});

test('production defaults to the postgres repository and requires DATABASE_URL', () => {
  assert.throws(
    () => parseServerEnv({ ...PROD }),
    /config-requires:DATABASE_URL/,
  );
  const options = parseServerEnv({ ...PROD, DATABASE_URL: 'postgres://u:p@db:5432/n' });
  assert.equal(options.repository, 'postgres');
  assert.equal(options.production, true);
});

test('production requires at least one authorization server (RFC 9728 metadata)', () => {
  const env = { ...PROD, DATABASE_URL: 'postgres://u:p@db:5432/n' };
  delete env.NOOSPHERE_AUTHORIZATION_SERVERS;
  assert.throws(() => parseServerEnv(env), /config-requires:NOOSPHERE_AUTHORIZATION_SERVERS/);
  // Non-production may still omit it.
  assert.doesNotThrow(() => parseServerEnv({ ...BASE }));
});

test('production must not run the ephemeral in-memory repository', () => {
  assert.throws(
    () => parseServerEnv({ ...BASE, NOOSPHERE_PRODUCTION: 'true', NOOSPHERE_REPOSITORY: 'memory' }),
    /production-requires-postgres-repository/,
  );
});

test('rejects an unknown NOOSPHERE_* environment variable', () => {
  assert.throws(
    () => parseServerEnv({ ...BASE, NOOSPHERE_TYPO_SETTING: 'x' }),
    /config-unknown-env:NOOSPHERE_TYPO_SETTING/,
  );
});

test('non-NOOSPHERE keys are ignored', () => {
  assert.doesNotThrow(() => parseServerEnv({ ...BASE, PATH: '/usr/bin', HOME: '/root' }));
});

test('requires the audience', () => {
  const env = { ...BASE };
  delete env.NOOSPHERE_AUDIENCE;
  assert.throws(() => parseServerEnv(env), /config-requires:NOOSPHERE_AUDIENCE/);
});

test('rejects a non-https jwks_uri', () => {
  assert.throws(
    () => parseServerEnv({ ...BASE, NOOSPHERE_OIDC_ISSUERS: JSON.stringify([{ iss: 'x', jwks_uri: 'http://issuer.example/jwks' }]) }),
    /config-jwks-uri-requires-https/,
  );
});

test('rejects malformed issuer JSON', () => {
  assert.throws(
    () => parseServerEnv({ ...BASE, NOOSPHERE_OIDC_ISSUERS: 'not-json' }),
    /config-invalid-oidc-issuers-json/,
  );
});

test('parses lists, port, quota, and body limit', () => {
  const options = parseServerEnv({
    ...BASE,
    NOOSPHERE_PORT: '9000',
    NOOSPHERE_ALLOWED_ORIGINS: 'https://a.example, https://b.example',
    NOOSPHERE_REQUIRED_SCOPES: 'project.read project.write',
    NOOSPHERE_AUTHORIZATION_SERVERS: 'https://issuer.example/',
    NOOSPHERE_PROJECTS_PER_OWNER: '50',
    NOOSPHERE_MAX_BODY_BYTES: '2097152',
  });
  assert.equal(options.port, 9000);
  assert.deepEqual(options.allowedOrigins, ['https://a.example', 'https://b.example']);
  assert.deepEqual(options.requiredScopes, ['project.read', 'project.write']);
  assert.equal(options.projectsPerOwner, 50);
  assert.equal(options.maxBodyBytes, 2097152);
});

test('rejects an out-of-range port', () => {
  assert.throws(() => parseServerEnv({ ...BASE, NOOSPHERE_PORT: '70000' }), /config-invalid-port/);
});
