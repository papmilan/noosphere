import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyExecutionFreshness } from '../continuity/acp/execution-freshness.js';

const SNAPSHOT = `sha256:${'a'.repeat(64)}`;
const PARENT = `sha256:${'9'.repeat(64)}`;
const OTHER = `sha256:${'e'.repeat(64)}`;
const HASH_FRESH = `sha256:${'1'.repeat(64)}`;
const HASH_OLD = `sha256:${'2'.repeat(64)}`;

const NOW = '2026-07-13T12:00:00.000Z';

function executionState({ projectSnapshotId = SNAPSHOT, expiresAt = '2026-07-16T00:00:00.000Z', createdAt = '2026-07-13T00:00:00.000Z' } = {}) {
  return {
    envelope: {
      project_snapshot_id: projectSnapshotId,
      created_at: createdAt,
      expires_at: expiresAt,
      cursor: { step_id: 's2' },
      steps: [
        { id: 's1', status: 'done', target: { file: 'a.js', content_hash: HASH_FRESH } },
        { id: 's2', status: 'current', target: { file: 'b.js', content_hash: HASH_OLD } },
        { id: 's3', status: 'pending', target: { file: 'c.js', content_hash: null } },
      ],
    },
  };
}

const exactGit = { status: 'exact', trustDowngrade: 0, actionable: true, reasons: [] };
const advancedGit = { status: 'advanced', trustDowngrade: 1, actionable: true, reasons: ['repository advanced beyond the snapshot head'] };
const divergedGit = { status: 'diverged', trustDowngrade: 2, actionable: false, reasons: ['snapshot head is not an ancestor of the current head'] };

function classify(overrides = {}) {
  return classifyExecutionFreshness({
    execution: executionState(overrides.execution ?? {}),
    currentSnapshotId: overrides.currentSnapshotId ?? SNAPSHOT,
    ancestorIds: overrides.ancestorIds ?? [],
    compatibility: overrides.compatibility ?? exactGit,
    fileHashes: overrides.fileHashes ?? { 'a.js': HASH_FRESH, 'b.js': HASH_OLD },
    now: overrides.now ?? NOW,
  });
}

describe('ACP execution freshness classification', () => {
  it('is fully fresh when binding, git, hashes, and age all hold', () => {
    const verdict = classify();
    assert.deepEqual(verdict, {
      binding: 'fresh',
      aged: false,
      historyOnly: false,
      actionable: true,
      steps: { s1: 'fresh', s2: 'fresh', s3: 'fresh' },
      reasons: [],
    });
  });

  it('demotes to rebased when the bound snapshot is an ancestor of the current one', () => {
    const verdict = classify({
      execution: { projectSnapshotId: PARENT },
      ancestorIds: [PARENT],
    });
    assert.equal(verdict.binding, 'rebased');
    assert.equal(verdict.actionable, false);
    assert.ok(verdict.reasons.some((reason) => /superseded/.test(reason)));
    // Per-step salvage still runs under rebased.
    assert.equal(verdict.steps.s1, 'fresh');
  });

  it('voids on an unrelated project snapshot', () => {
    const verdict = classify({ execution: { projectSnapshotId: OTHER } });
    assert.equal(verdict.binding, 'void');
    assert.equal(verdict.actionable, false);
    assert.deepEqual(verdict.steps, {});
  });

  it('voids on diverged git regardless of binding', () => {
    const verdict = classify({ compatibility: divergedGit });
    assert.equal(verdict.binding, 'void');
    assert.equal(verdict.actionable, false);
    assert.ok(verdict.reasons.includes('snapshot head is not an ancestor of the current head'));
  });

  it('salvages per step under advanced git', () => {
    const verdict = classify({
      compatibility: advancedGit,
      fileHashes: { 'a.js': HASH_FRESH, 'b.js': `sha256:${'f'.repeat(64)}` },
    });
    assert.equal(verdict.binding, 'fresh');
    assert.equal(verdict.steps.s1, 'fresh');
    assert.equal(verdict.steps.s2, 'stale');
    // No hash recorded: inherits the envelope-level verdict (advanced → stale).
    assert.equal(verdict.steps.s3, 'stale');
  });

  it('treats hashless steps as fresh under exact git', () => {
    const verdict = classify();
    assert.equal(verdict.steps.s3, 'fresh');
  });

  it('marks a hash mismatch stale even under exact git', () => {
    const verdict = classify({ fileHashes: { 'a.js': HASH_FRESH, 'b.js': `sha256:${'f'.repeat(64)}` } });
    assert.equal(verdict.steps.s2, 'stale');
    assert.equal(verdict.actionable, true);
  });

  it('ages past expires_at without voiding, and never deletes', () => {
    const verdict = classify({ now: '2026-07-17T00:00:00.000Z' });
    assert.equal(verdict.aged, true);
    assert.equal(verdict.binding, 'fresh');
    assert.equal(verdict.actionable, false);
    assert.ok(verdict.reasons.some((reason) => /aged/.test(reason)));
  });

  it('becomes history-only past the 30-day cap', () => {
    const verdict = classify({ now: '2026-08-13T00:00:01.000Z' });
    assert.equal(verdict.historyOnly, true);
    assert.equal(verdict.actionable, false);
  });

  it('is deterministic for equal inputs', () => {
    assert.deepEqual(classify(), classify());
  });
});
