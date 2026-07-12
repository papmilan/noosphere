// Deterministic, bounded continuity kernel. Mandatory content (repository
// compatibility, objective, unresolved conflicts, blockers) must always fit; if
// it cannot, the kernel refuses to summarize rather than silently drop a
// conflict or blocker. Optional sections are appended whole or not at all, so an
// item is never truncated mid-text.

const BUDGET = 1_800;

const UNSAFE_KERNEL = [
  '# ACP CONTINUITY KERNEL',
  'Status: unsafe-to-summarize',
  'Reason: mandatory ACP conflicts or blockers exceed the safe kernel budget.',
  'Next: run `noosphere state --json` and resolve the listed conflicts before acting.',
].join('\n');

export function unresolvedConflicts(state) {
  const generated = state.runtime.conflicts;
  const persisted = (state.envelope.conflicts ?? []).filter((conflict) => conflict.status === 'unresolved');
  return [...generated, ...persisted];
}

export function renderKernel(state, inputs = {}) {
  const compatibility = inputs.compatibility ?? { status: 'unknown', actionable: false, reasons: [] };
  const conflicts = unresolvedConflicts(state);
  const blockers = activeItems(state, 'blockers');

  const mandatory = [
    '# ACP CONTINUITY KERNEL',
    `Snapshot: ${inputs.snapshotId ?? state.envelope.snapshot_id}`,
    `Repository: ${compatibility.status} (${compatibility.actionable ? 'actionable' : 'not actionable'})`,
    `Phase: ${state.envelope.phase}`,
    `Objective: ${state.envelope.goal.current_objective}`,
    ...conflicts.map(conflictLine),
    ...blockers.map((item) => `BLOCKER: ${item.text}`),
  ].join('\n');

  if (byteLength(mandatory) > BUDGET) return UNSAFE_KERNEL;

  let output = mandatory;
  for (const section of optionalSections(state)) {
    if (!section) continue;
    const candidate = `${output}\n${section}`;
    if (byteLength(candidate) <= BUDGET) output = candidate;
  }
  return output;
}

function optionalSections(state) {
  return [
    section(activeItems(state, 'risks').map((item) => `RISK: ${item.text}`)),
    section(activeItems(state, 'decisions').map((item) => `DECISION [${item.domain}]: ${item.text}`)),
    section([`Stance: confidence=${state.envelope.working_stance.confidence}, momentum=${state.envelope.working_stance.momentum}, risk=${state.envelope.working_stance.risk_posture}`]),
    section(nextActionLine(state)),
    referenceSection(state),
  ];
}

function nextActionLine(state) {
  const actions = activeItems(state, 'next_actions')
    .slice()
    .sort((left, right) => priorityOf(left) - priorityOf(right) || compareText(left.id, right.id));
  return actions.length ? [`NEXT: ${actions[0].text}`] : [];
}

function referenceSection(state) {
  const refs = Object.values(state.runtime.referencesById)
    .slice()
    .sort((left, right) => compareText(left.id, right.id))
    .map((ref) => `REF ${ref.kind} ${ref.id}: ${ref.locator}`);
  return section(refs);
}

function conflictLine(conflict) {
  const domain = conflict.domain ? `:${conflict.domain}` : '';
  const values = conflict.candidates.map((candidate) => candidate.value).join(' vs ');
  return `UNRESOLVED CONFLICT [${conflict.kind}${domain}]: ${values}`;
}

function section(lines) {
  return lines.length ? lines.join('\n') : '';
}

function activeItems(state, type) {
  const ids = state.runtime.activeByType[type] ?? [];
  return ids.map((id) => state.runtime.byId[id]);
}

function priorityOf(item) {
  return Number.isInteger(item.priority) ? item.priority : Number.MAX_SAFE_INTEGER;
}

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
