// Pure freshness classification for an execution checkpoint. Evidence voids,
// age demotes: the wall clock can only remove NEXT-step prominence, never
// invalidate data. All inputs are explicit — Project State binding, the Git
// compatibility verdict from classifyCompatibility, measured file hashes, and
// the clock — so equal inputs produce byte-identical verdicts.

export const executionFreshnessPolicy = Object.freeze({
  ttlMs: 72 * 60 * 60 * 1000,
  retentionMs: 30 * 24 * 60 * 60 * 1000,
});

export function classifyExecutionFreshness({
  execution,
  currentSnapshotId,
  ancestorIds = [],
  compatibility,
  fileHashes = {},
  now,
  policy = executionFreshnessPolicy,
}) {
  const envelope = execution.envelope;
  const reasons = [];

  let binding;
  if (envelope.project_snapshot_id === currentSnapshotId) {
    binding = 'fresh';
  } else if (ancestorIds.includes(envelope.project_snapshot_id)) {
    binding = 'rebased';
    reasons.push('bound project state was superseded by a descendant snapshot');
  } else {
    binding = 'void';
    reasons.push('bound project state is unrelated to the current snapshot');
  }

  const gitActionable = compatibility.status === 'exact'
    || compatibility.status === 'compatible'
    || compatibility.status === 'advanced';
  if (binding !== 'void' && !gitActionable) {
    binding = 'void';
    reasons.push(...compatibility.reasons);
  }

  // Expiry is never a model assertion. It is derived from the observed
  // checkpoint creation time and the local policy, even if an old envelope
  // contains a forged expires_at value.
  const createdAt = Date.parse(envelope.created_at);
  const ageMs = Date.parse(now) - createdAt;
  const aged = ageMs >= policy.ttlMs;
  if (aged) reasons.push('checkpoint aged past the policy TTL boundary');
  const historyOnly = ageMs > policy.retentionMs;

  if (binding === 'void') {
    return verdict({ binding, aged, historyOnly, actionable: false, steps: {}, reasons });
  }

  // A matching target hash only says the target has not changed. It cannot
  // prove that assumptions, dependencies, or the intended step remain valid.
  const steps = {};
  for (const step of envelope.steps) {
    if (step.target.content_hash == null) {
      steps[step.id] = 'unknown';
    } else {
      const observed = fileHashes[step.target.file];
      if (observed === null || observed?.status === 'missing') {
        steps[step.id] = 'target-missing';
      } else if (observed?.status === 'unknown' || observed == null) {
        steps[step.id] = 'unknown';
      } else {
        const hash = typeof observed === 'string' ? observed : observed.hash;
        steps[step.id] = hash === step.target.content_hash ? 'target-unchanged' : 'target-changed';
      }
    }
  }

  const actionable = binding === 'fresh' && !aged && !historyOnly;
  return verdict({ binding, aged, historyOnly, actionable, steps, reasons });
}

function verdict({ binding, aged, historyOnly, actionable, steps, reasons }) {
  return { binding, aged, historyOnly, actionable, steps, reasons };
}
