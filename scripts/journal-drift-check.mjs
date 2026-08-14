#!/usr/bin/env node
// Stop-hook guard against the failure this repository keeps having: commits land,
// the machine records their position, and nobody writes down why. CLAUDE.md
// instruction 8 already says to append findings to the journal. An instruction
// read at session start is not a mechanism — it is a reminder at the wrong
// moment, three hours before the moment it matters. This is the mechanism.
//
// On 2026-08-14 the journal was 11 days stale while the session was fixing the
// journal machinery itself. The hook exists so that cannot repeat quietly.
//
// Contract: reads the Stop-hook payload on stdin, exits 2 with a message on
// stderr to hand that message back to the agent, and exits 0 in every other
// case. A telemetry guard must never be able to fail a turn — same reasoning as
// the post-commit hook it watches.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Below this, silence. One or two unjournalled commits is work in progress; a
// hook that fires on every commit is a hook that gets deleted, taking the whole
// guard with it. Tune with NOOSPHERE_JOURNAL_DRIFT_THRESHOLD.
const THRESHOLD = Number(process.env.NOOSPHERE_JOURNAL_DRIFT_THRESHOLD ?? 3);
const SHORT_HEAD = 12;
const FULL_HEAD = /^[0-9a-f]{40}$/;

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function main() {
  const payload = readStdin();
  // The loop guard. Without it a blocked stop re-runs this hook, which blocks
  // again, forever. Claude Code sets this once it has already been blocked.
  //
  // It is ONLY that. It says nothing about earlier turns: a new turn is a fresh
  // stop with the flag clear, so this alone re-fires on every single turn that
  // has drift. Measured, not assumed — it fired twice in consecutive turns on
  // the session that wrote it, which is exactly the nagging that gets a hook
  // deleted. The once-per-session guard below is the real one.
  if (payload.stop_hook_active === true) return 0;

  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  // Keyed on the session, so a session that has already been told stays told.
  // Lives under .claude/ because that is gitignored and machine-local, like the
  // hook wiring itself; .noosphere/ is another tool's namespace, not ours.
  const marker = path.join(root, '.claude', 'journal-drift-state.json');
  const session = typeof payload.session_id === 'string' ? payload.session_id : null;
  if (session !== null && readJson(marker)?.last_session_id === session) return 0;
  const observations = readJson(path.join(root, '.noosphere', 'commit-observations.json'));
  if (observations === null) return 0;

  const entries = Array.isArray(observations) ? observations : observations.observations;
  if (!Array.isArray(entries)) return 0;

  let journal = '';
  try {
    journal = readFileSync(path.join(root, '.noosphere', 'journal.md'), 'utf8');
  } catch {
    return 0;
  }

  // The same watermark the draft builder uses: an observation counts as
  // journalled once its short head appears in the journal. Deliberately NOT a
  // call into buildJournalDraft — that shells out to `git show` once per commit,
  // and this runs after every single assistant turn.
  const unjournalled = entries.filter((entry) => {
    const head = entry?.head;
    return typeof head === 'string'
      && FULL_HEAD.test(head)
      && !journal.includes(head.slice(0, SHORT_HEAD));
  });
  if (unjournalled.length < THRESHOLD) return 0;

  // Recorded before the message goes out, so a session is marked as told even
  // if the agent ignores what follows. Best-effort: an unwritable marker costs
  // a repeat reminder, never a failed turn.
  if (session !== null) {
    try {
      mkdirSync(path.dirname(marker), { recursive: true });
      writeFileSync(marker, `${JSON.stringify({ last_session_id: session }, null, 2)}\n`);
    } catch {
      // Ignored on purpose. See above.
    }
  }

  const draft = path.join(root, '.noosphere', 'pending-journal.md');
  const pending = readJson(draft) === null && safeExists(draft);
  process.stderr.write([
    `${unjournalled.length} commits on this project have no journal entry.`,
    '',
    pending
      ? `A draft is already waiting at ${draft} — add what the work was FOR, then ask the owner to run \`noosphere journal confirm\`.`
      : 'Run `noosphere journal draft --path "$CLAUDE_PROJECT_DIR"`, then write the reasoning into the draft it leaves behind.',
    '',
    'The commit list is measured and already correct. What is missing is why:',
    'findings, decisions, failed approaches, handoffs (CLAUDE.md instruction 8).',
    'Then hand the confirmation to the owner — confirming your own draft is not',
    'yours to do. If journalling genuinely does not apply to this turn, say so',
    'and continue; you will not be asked again this session.',
  ].join('\n'));
  return 2;
}

function safeExists(file) {
  try {
    readFileSync(file);
    return true;
  } catch {
    return false;
  }
}

process.exit(main());
