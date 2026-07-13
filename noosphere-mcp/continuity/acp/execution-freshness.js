// Pure freshness classification for an execution checkpoint. Evidence voids,
// age demotes: the wall clock can only remove NEXT-step prominence, never
// invalidate data. All inputs are explicit — Project State binding, the Git
// compatibility verdict from classifyCompatibility, measured file hashes, and
// the clock — so equal inputs produce byte-identical verdicts.

const HISTORY_CAP_MS = 30 * 24 * 60 * 60 * 1000;

export function classifyExecutionFreshness({
  execution,
  currentSnapshotId,
  ancestorIds = [],
  compatibility,
  fileHashes = {},
  now,
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

  const aged = envelope.expires_at < now;
  if (aged) reasons.push('checkpoint aged past its expires_at boundary');
  const historyOnly = Date.parse(now) - Date.parse(envelope.created_at) > HISTORY_CAP_MS;

  if (binding === 'void') {
    return verdict({ binding, aged, historyOnly, actionable: false, steps: {}, reasons });
  }

  // Per-step salvage: a measured hash that still matches keeps the step
  // fresh even when the envelope-level context moved; a mismatch marks it
  // stale; no recorded hash inherits the envelope-level verdict.
  const inheritFresh = binding === 'fresh'
    && (compatibility.status === 'exact' || compatibility.status === 'compatible');
  const steps = {};
  for (const step of envelope.steps) {
    if (step.target.content_hash == null) {
      steps[step.id] = inheritFresh ? 'fresh' : 'stale';
    } else {
      steps[step.id] = fileHashes[step.target.file] === step.target.content_hash ? 'fresh' : 'stale';
    }
  }

  const actionable = binding === 'fresh' && !aged && !historyOnly;
  return verdict({ binding, aged, historyOnly, actionable, steps, reasons });
}

function verdict({ binding, aged, historyOnly, actionable, steps, reasons }) {
  return { binding, aged, historyOnly, actionable, steps, reasons };
}
