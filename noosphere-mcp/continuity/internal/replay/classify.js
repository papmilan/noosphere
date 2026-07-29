export function classifyReplayObservation({
  priorCount,
  duplicateCandidate,
}) {
  if (
    !Number.isSafeInteger(priorCount) ||
    priorCount < 0 ||
    priorCount >= Number.MAX_SAFE_INTEGER ||
    typeof duplicateCandidate !== 'boolean'
  ) {
    throw new TypeError('replay classification input is invalid');
  }
  const replayCount = priorCount + 1;
  const state = replayCount === 1 ? 'SeenOnce' : 'Replayed';
  const classification = duplicateCandidate
    ? (priorCount === 0 ? 'NEW' : 'SUPPRESSED')
    : priorCount === 0
      ? 'NEW'
      : priorCount === 1
        ? 'SEEN'
        : 'REPLAYED';
  return Object.freeze({ classification, replayCount, state });
}
