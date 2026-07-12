import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ACP_LIMITS,
  ACP_SCHEMA,
  canonicalize,
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
