import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ACP_LIMITS,
  ACP_SCHEMA,
  canonicalize,
  decodeEnvelope,
  digestEnvelope,
  digestHeadSet,
  normalizeHeadIds,
} from '../index.js';

describe('ACP protocol constants and head sets', () => {
  it('defines the normative bounded defaults', () => {
    assert.deepEqual(ACP_LIMITS, {
      snapshotBytes: 1_048_576,
      indexedSnapshotsPerProject: 10_000,
      concurrentHeadsPerProject: 32,
      ancestryEnvelopes: 200,
      indexedBytesPerProject: 268_435_456,
      liveConfirmations: 16,
    });
  });

  it('canonicalizes the empty head set to the normative digest', () => {
    assert.equal(canonicalize([]), '[]');
    assert.equal(digestHeadSet([]), 'sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945');
  });

  it('rejects object keys that collide after Unicode normalization', () => {
    const input = {};
    input['caf\u00e9'] = 'composed';
    input['cafe\u0301'] = 'decomposed';

    assert.throws(
      () => canonicalize(input),
      (error) => error?.code === 'normalized-key-collision',
    );
  });

  it('rejects values that cannot exist in a JSON wire document', () => {
    assert.throws(
      () => canonicalize({ extension: undefined }),
      (error) => error?.code === 'non-json-value',
    );
    assert.throws(
      () => canonicalize({ extension: () => 'hidden' }),
      (error) => error?.code === 'non-json-value',
    );
  });

  it('rejects sparse arrays instead of hashing ambiguous bytes', () => {
    const sparse = new Array(2);
    sparse[1] = 'present';

    assert.throws(
      () => canonicalize(sparse),
      (error) => error?.code === 'sparse-array',
    );
  });

  it('rejects cyclic JavaScript objects with a bounded wire error', () => {
    const cyclic = {};
    cyclic.self = cyclic;

    assert.throws(
      () => canonicalize(cyclic),
      (error) => error?.code === 'cyclic-reference',
    );
  });

  it('validates derived fields before excluding them from an envelope digest', () => {
    assert.throws(
      () => digestEnvelope({
        snapshot_id: undefined,
        integrity: { digest: undefined, signature: { value: () => 'not-json' } },
        stable: true,
      }),
      (error) => error?.code === 'non-json-value',
    );
  });

  it('rejects malformed UTF-8 bytes before parsing JSON', () => {
    const result = decodeEnvelope(Buffer.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d]));

    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'invalid-utf8');
  });

  it('sorts and rejects duplicate or malformed head IDs', () => {
    assert.deepEqual(normalizeHeadIds([`sha256:${'b'.repeat(64)}`, `sha256:${'a'.repeat(64)}`]), [`sha256:${'a'.repeat(64)}`, `sha256:${'b'.repeat(64)}`]);
    assert.throws(() => normalizeHeadIds([`sha256:${'a'.repeat(64)}`, `sha256:${'a'.repeat(64)}`]), /duplicate-head/);
    assert.throws(() => normalizeHeadIds(['sha256:ABC']), /invalid-head-id/);
    assert.throws(() => normalizeHeadIds('sha256:not-an-array'), /invalid-head-set/);
  });

  it('exports the packaged schema as the source of fixture requirements', () => {
    assert.equal(ACP_SCHEMA.properties.protocol.const, 'acp.project-state-envelope');
    assert.equal(ACP_SCHEMA.properties.schema_version.const, '1.0.0');
    assert.ok(ACP_SCHEMA.required.includes('integrity'));
  });
});
