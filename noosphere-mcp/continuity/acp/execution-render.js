// Bounded advisory projection of an execution checkpoint. The reader is the
// next agent; everything here is a record of what the previous agent observed
// and intended, never an instruction. Mandatory content (header, age,
// freshness verdict, current position, validation truth) always fits or the
// kernel refuses to summarize; optional sections are appended whole or not at
// all, so no item is ever truncated mid-text.

import { oneLine } from './render.js';

const BUDGET = 1_200;

const HEADER = '# EXECUTION CHECKPOINT (advisory — validate before acting)';

const UNSAFE_KERNEL = [
  HEADER,
  'Status: unsafe-to-summarize',
  'Reason: mandatory execution context exceeds the safe kernel budget.',
  'Next: run `noosphere exec show --json` and inspect the checkpoint directly.',
].join('\n');

export function renderExecutionKernel(execution, { verdict, now, contention = [] } = {}) {
  const envelope = execution.envelope;
  const age = formatAge(envelope.created_at, now);

  if (verdict.historyOnly) {
    return `Aged execution checkpoint from ${envelope.created_at} exists; run \`noosphere exec show --history\`.`;
  }

  if (verdict.binding === 'void') {
    return [
      HEADER,
      `Previous agent recorded a checkpoint ${age}, but it is VOID here:`,
      ...verdict.reasons.map((reason) => `- ${oneLine(reason)}`),
      'Do not act on it. Plan from the ACP project kernel and the repository.',
    ].join('\n');
  }

  const byId = new Map(envelope.steps.map((step) => [step.id, step]));
  const current = byId.get(envelope.cursor.step_id);

  const mandatory = [
    HEADER,
    `Previous agent recorded this ${age} (agent: ${oneLine(envelope.origin.agent_id)}).`,
    `Binding: ${verdict.binding}${verdict.aged ? ', aged' : ''}${verdict.reasons.length ? ` — ${verdict.reasons.map(oneLine).join('; ')}` : ''}`,
    ...(verdict.aged
      ? ['This checkpoint aged past its boundary; adopt only via `noosphere exec resume --accept-aged`.']
      : []),
    ...(current
      ? [`Current: ${current.kind} ${oneLine(current.target.file)}${current.target.symbol ? ` ${oneLine(current.target.symbol)}` : ''} — ${oneLine(current.goal)} (cursor: ${envelope.cursor.status})`]
      : []),
    `Validation: ${envelope.validation.last_result ?? 'none'}${envelope.validation.last_command ? ` (\`${oneLine(envelope.validation.last_command)}\`)` : ''}${envelope.validation.failing_tests.length ? ` failing: ${envelope.validation.failing_tests.map(oneLine).join(', ')}` : ''}`,
    ...contention.map((item) => `CONTENTION: ${oneLine(item.agent_id)} also targets ${oneLine(item.file)} — coordinate before editing.`),
  ].join('\n');

  if (byteLength(mandatory) > BUDGET) return UNSAFE_KERNEL;

  let output = mandatory;
  for (const section of optionalSections(envelope, verdict, current)) {
    if (!section) continue;
    const candidate = `${output}\n${section}`;
    if (byteLength(candidate) <= BUDGET) output = candidate;
  }
  return output;
}

function optionalSections(envelope, verdict, current) {
  const pendingFresh = envelope.steps.filter(
    (step) => step.status === 'pending' && verdict.steps[step.id] === 'fresh' && step !== current,
  );
  const nextLines = verdict.actionable
    ? pendingFresh.slice(0, 3).map((step, index) => `${index === 0 ? 'NEXT' : 'THEN'}: ${oneLine(step.goal)} (${step.kind} ${oneLine(step.target.file)}; verify: \`${oneLine(step.verify.command)}\`)`)
    : [];
  const staleLines = envelope.steps
    .filter((step) => verdict.steps[step.id] === 'stale')
    .map((step) => `STALE (re-verify first): ${step.kind} ${oneLine(step.target.file)} — ${oneLine(step.goal)}`);
  const blockedLines = envelope.steps
    .filter((step) => step.status === 'blocked')
    .map((step) => `BLOCKED: ${oneLine(step.goal)} (${oneLine(step.target.file)})`);
  const frontierLines = [
    ...envelope.frontier.searched.map((item) => `SEARCHED ${oneLine(item.query)} in ${oneLine(item.scope)}: ${oneLine(item.finding)}`),
    ...envelope.frontier.ruled_out.map((item) => `RULED OUT: ${oneLine(item.hypothesis)} — ${oneLine(item.evidence)}`),
  ];
  const noteLines = envelope.working_notes.map((note) => `NOTE: ${oneLine(note.text)}`);
  return [
    section(nextLines),
    section(blockedLines),
    section(staleLines),
    section(frontierLines),
    section(noteLines),
  ];
}

function formatAge(createdAt, now) {
  const ms = Math.max(0, Date.parse(now) - Date.parse(createdAt));
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `recorded ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `recorded ${hours} h ago`;
  return `recorded ${Math.floor(hours / 24)} d ago`;
}

function section(lines) {
  return lines.length ? lines.join('\n') : '';
}

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}
