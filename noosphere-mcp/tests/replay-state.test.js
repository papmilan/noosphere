import assert from 'node:assert/strict';
import test from 'node:test';

const classifyModule = await import(
  '../continuity/internal/replay/classify.js'
).catch(() => null);

test('classification is the exact monotonic replay state mapping', () => {
  assert.ok(classifyModule, 'production replay classifier must exist');
  const classify = classifyModule.classifyReplayObservation;
  assert.deepEqual(classify({ priorCount: 0, duplicateCandidate: false }), {
    classification: 'NEW',
    replayCount: 1,
    state: 'SeenOnce',
  });
  assert.deepEqual(classify({ priorCount: 1, duplicateCandidate: false }), {
    classification: 'SEEN',
    replayCount: 2,
    state: 'Replayed',
  });
  assert.deepEqual(classify({ priorCount: 2, duplicateCandidate: false }), {
    classification: 'REPLAYED',
    replayCount: 3,
    state: 'Replayed',
  });
  assert.deepEqual(classify({ priorCount: 1, duplicateCandidate: true }), {
    classification: 'SUPPRESSED',
    replayCount: 2,
    state: 'Replayed',
  });
});

test('classification refuses invalid or overflowing counters', () => {
  assert.ok(classifyModule, 'production replay classifier must exist');
  for (const priorCount of [-1, 1.5, Number.MAX_SAFE_INTEGER]) {
    assert.throws(
      () => classifyModule.classifyReplayObservation({
        priorCount,
        duplicateCandidate: false,
      }),
    );
  }
  assert.throws(() => classifyModule.classifyReplayObservation({
    priorCount: 0,
    duplicateCandidate: 'yes',
  }));
});
