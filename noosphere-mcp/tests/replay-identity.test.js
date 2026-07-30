import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { normalizeUntrusted } from '../continuity/memory-safety.js';
import { canonicalize } from '../continuity/trust-store-internal.js';

const identityModule = await import(
  '../continuity/internal/replay/identity.js'
).catch(() => null);

const PROJECT = `sha256:${'a'.repeat(64)}`;

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function expectedIdentity({ projectIdentityDigest, slot, content }) {
  const normalizedBytes = Buffer.from(normalizeUntrusted(content), 'utf8');
  const payloadDigest = digest(normalizedBytes);
  const replayIdentity = digest(Buffer.from(canonicalize([
    'noosphere.replay-identity.v1',
    projectIdentityDigest,
    slot,
    payloadDigest,
  ]), 'utf8'));
  return { normalizedBytes, payloadDigest, replayIdentity };
}

test('derives the exact canonical replay identity vector', () => {
  assert.ok(identityModule, 'production replay identity module must exist');
  assert.equal(
    typeof identityModule.deriveReplayIdentity,
    'function',
    'production replay identity function must exist',
  );

  const input = {
    projectIdentityDigest: PROJECT,
    slot: 'master-prompt',
    content: '  Untrusted\r\nmemory\u0000  ',
  };
  const actual = identityModule.deriveReplayIdentity(input);
  const expected = expectedIdentity(input);

  assert.deepEqual(Object.keys(actual), [
    'normalizedBytes',
    'payloadDigest',
    'replayIdentity',
  ]);
  assert.deepEqual(actual.normalizedBytes, expected.normalizedBytes);
  assert.equal(actual.payloadDigest, expected.payloadDigest);
  assert.equal(actual.replayIdentity, expected.replayIdentity);
  assert.match(actual.replayIdentity, /^sha256:[0-9a-f]{64}$/);
});

test('identity changes only with project, trusted local slot, or content', () => {
  assert.ok(identityModule, 'production replay identity module must exist');
  const derive = identityModule.deriveReplayIdentity;
  assert.equal(typeof derive, 'function');

  const first = derive({
    projectIdentityDigest: PROJECT,
    slot: 'ordinary',
    content: 'same memory',
  });
  const again = derive({
    projectIdentityDigest: PROJECT,
    slot: 'ordinary',
    content: 'same memory',
  });

  assert.equal(first.replayIdentity, again.replayIdentity);
  assert.notEqual(first.replayIdentity, derive({
    projectIdentityDigest: `sha256:${'b'.repeat(64)}`,
    slot: 'ordinary',
    content: 'same memory',
  }).replayIdentity);
  assert.notEqual(first.replayIdentity, derive({
    projectIdentityDigest: PROJECT,
    slot: 'baseline',
    content: 'same memory',
  }).replayIdentity);
  assert.notEqual(first.replayIdentity, derive({
    projectIdentityDigest: PROJECT,
    slot: 'ordinary',
    content: 'same memorx',
  }).replayIdentity);
});

test('identity is stable across independent processes', () => {
  assert.ok(identityModule, 'production replay identity module must exist');
  const moduleUrl = new URL(
    '../continuity/internal/replay/identity.js',
    import.meta.url,
  ).href;
  const input = {
    projectIdentityDigest: PROJECT,
    slot: 'followups',
    content: 'cross-session memory',
  };
  const script = [
    `import { deriveReplayIdentity } from ${JSON.stringify(moduleUrl)};`,
    `const result = deriveReplayIdentity(${JSON.stringify(input)});`,
    'process.stdout.write(result.replayIdentity);',
  ].join('\n');

  const childIdentity = execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    { encoding: 'utf8' },
  );
  assert.equal(
    childIdentity,
    identityModule.deriveReplayIdentity(input).replayIdentity,
  );
});

test('rejects remote metadata and every replay/candidate identity crossover', () => {
  assert.ok(identityModule, 'production replay identity module must exist');
  const derive = identityModule.deriveReplayIdentity;
  const base = {
    projectIdentityDigest: PROJECT,
    slot: 'ordinary',
    content: 'memory',
  };

  for (const hostile of [
    { ...base, timestamp: '2026-07-29T00:00:00.000Z' },
    { ...base, ranking: 1 },
    { ...base, candidateId: 'a'.repeat(52) },
    { ...base, candidatePath: '/tmp/candidate' },
    { ...base, replayIdentity: `sha256:${'c'.repeat(64)}` },
    { ...base, [Symbol('candidateId')]: 'symbol-candidate' },
    Object.assign(Object.create({ candidateId: 'inherited' }), base),
  ]) {
    assert.throws(
      () => derive(hostile),
      /exactly projectIdentityDigest, slot, and content/,
    );
  }
});

test('rejects malformed canonical identity inputs', () => {
  assert.ok(identityModule, 'production replay identity module must exist');
  const derive = identityModule.deriveReplayIdentity;

  for (const input of [
    null,
    {},
    { projectIdentityDigest: 'a'.repeat(64), slot: 'ordinary', content: 'x' },
    { projectIdentityDigest: PROJECT, slot: 'remote-slot', content: 'x' },
    { projectIdentityDigest: PROJECT, slot: 'ordinary', content: Buffer.from('x') },
  ]) {
    assert.throws(() => derive(input));
  }
});
