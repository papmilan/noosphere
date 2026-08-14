import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';

import { normalizeUntrusted } from '../memory-safety.js';
import {
  appendRepositoryFile,
  atomicRepositoryWrite,
  readBoundedRegularFile,
  removeRepositoryFile,
} from '../secure-fs.js';
import { assertInteractiveStreams, readExactConfirmation } from '../internal/exact-confirmation.js';
import { ensureRuntimeStateIgnored } from '../csp/storage.js';
import { readCommitObservations } from './commit-observations.js';

// Item 4 of docs/design/specs/2026-08-12-inferred-continuity.md: a journal
// entry drafted from what was measured, appended only after the owner confirms
// the exact bytes.
//
// The draft states position, never intent — the same line item 3 holds. What
// makes this worth having is the editing step: the owner opens the pending file
// and writes down what they were actually doing, and the commit list is already
// there so they do not have to reconstruct it. Confirmation binds to the bytes
// on disk at confirm time, so an edit between draft and confirmation is shown
// and re-hashed rather than riding along unreviewed.
const PENDING = 'pending-journal.md';

// One pending draft, ever. A per-commit draft queue would become another inbox
// nobody reads, which is the failure this design exists to fix rather than
// re-dress. Superseding the old draft is still the pruning — it just has to be
// asked for, because the draft is the file the owner writes their prose into.
const MAX_DRAFT_COMMITS = 20;
const MAX_SUBJECT_CHARS = 200;
const MAX_BRANCH_CHARS = 100;
const MAX_DRAFT_BYTES = 256 * 1024;
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
const MAX_CONFIRMATION_BYTES = 256;
const SHORT_HEAD = 12;
const FULL_HEAD = /^[0-9a-f]{40}$/;

const execFileAsync = promisify(execFile);

export function pendingJournalPath(root) {
  return path.join(root, '.noosphere', PENDING);
}

export function draftHash(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// Same shape as the trust ceremony's confirmationPhrase(slot, rawHash): typing
// it proves the owner is looking at THESE bytes, and a phrase from an earlier
// draft no longer matches.
export function journalConfirmationPhrase(rawHash) {
  return `append journal ${rawHash.slice(0, 8)}`;
}

/**
 * Reads the pending draft, normalized. Returns null when there is none.
 *
 * Normalization happens on read rather than at display time so one string is
 * hashed, shown, and appended. Anything else lets the owner approve a rendering
 * of bytes rather than the bytes.
 */
export async function readJournalDraft(root) {
  const raw = await readBoundedRegularFile(pendingJournalPath(root), {
    maxBytes: MAX_DRAFT_BYTES,
  }).catch(() => null);
  if (raw === null) return null;
  const text = normalizeUntrusted(raw.toString('utf8'));
  return text.trim() ? text : null;
}

export async function writeJournalDraft(root, text, { replace = false } = {}) {
  // "Edit it to say what you were doing" is the entire feature, so the pending
  // file is the one place the owner's own prose lives before it is journalled —
  // and it is runtime state, so it is gitignored and there is no copy anywhere.
  // A second draft used to overwrite it silently, which lost writing that
  // nothing could recover. Refusing costs one `discard` when the old draft was
  // untouched; overwriting costs the only copy when it was not.
  //
  // Read-then-write, not an exclusive create: two concurrent drafters both hold
  // machine-generated text, since prose can only be typed into a draft that
  // already finished being written. The race cannot destroy what this guards.
  if (!replace && (await readJournalDraft(root)) !== null) {
    const error = new Error(
      'A pending journal draft already exists. Confirm it with `noosphere journal confirm`, '
      + 'drop it with `noosphere journal discard`, or pass --replace to overwrite it — '
      + 'anything you wrote into it is lost.',
    );
    error.code = 'journal-draft-exists';
    throw error;
  }
  // Same reason as the observations file: a draft is unconfirmed local work,
  // and a project that never added a .gitignore line for it must not find one
  // untracked the first time it drafts.
  await ensureRuntimeStateIgnored(root);
  await atomicRepositoryWrite(pendingJournalPath(root), text, { root });
}

export async function discardJournalDraft(root) {
  return removeRepositoryFile(pendingJournalPath(root), { root });
}

/**
 * Builds an entry covering every observed commit the journal does not already
 * name. Returns null when there is nothing new, which is a skip, not a failure.
 */
export async function buildJournalDraft(root, now, { limit = MAX_DRAFT_COMMITS } = {}) {
  const observations = (await readCommitObservations(root))
    .filter((observation) => FULL_HEAD.test(observation?.head ?? ''));
  if (observations.length === 0) return null;

  // The watermark is the journal itself: an observation counts as journalled
  // once its short head appears there. No extra state file to drift, and an
  // entry the owner wrote by hand naming a commit also suppresses it. A short
  // head that appears for some unrelated reason drops one commit from a draft,
  // which is a cheaper failure than double-journalling it.
  const journal = await readJournalText(root);
  const unjournalled = observations.filter(
    (observation) => !journal.includes(observation.head.slice(0, SHORT_HEAD)),
  );
  if (unjournalled.length === 0) return null;

  const kept = unjournalled.slice(-limit);
  const elided = unjournalled.length - kept.length;
  const lines = [];
  for (const observation of kept) lines.push(await commitLine(root, observation));

  const text = [
    `## ${now} — git-hook / observed-commits`,
    '',
    'Commit positions recorded since the last journal entry. These are measured;',
    'nothing here states why the work was done. Write that in yourself, then run',
    '`noosphere journal confirm` — it hashes this file as it stands, so an edit',
    'made in between is shown again before anything is appended.',
    '',
    ...lines,
    ...(elided > 0
      ? ['', `(${elided} older observed commit${elided === 1 ? '' : 's'} not listed.)`]
      : []),
    '',
  ].join('\n');

  return { text, commits: kept.length, elided };
}

/**
 * Appends the pending draft to the journal once `confirm` returns true. Throws
 * on every other path; nothing is written unless the owner confirmed.
 */
export async function confirmJournalDraft({
  root,
  confirm,
  input = process.stdin,
  output = process.stdout,
} = {}) {
  const text = await readJournalDraft(root);
  if (text === null) {
    throw new Error('No pending journal draft; run `noosphere journal draft` first.');
  }
  const rawHash = draftHash(text);
  const phrase = journalConfirmationPhrase(rawHash);
  const approved = await (confirm ?? ttyConfirm)({
    text,
    rawHash,
    phrase,
    draftPath: pendingJournalPath(root),
    byteLength: Buffer.byteLength(text, 'utf8'),
    input,
    output,
  });
  if (approved !== true) {
    throw new Error('Confirmation did not match; the draft was left untouched.');
  }
  await appendRepositoryFile(path.join(root, '.noosphere', 'journal.md'), text, {
    root,
    maxBytes: MAX_JOURNAL_BYTES,
  });
  await discardJournalDraft(root);
  return { rawHash, bytes: Buffer.byteLength(text, 'utf8') };
}

// Interactive only, for the same reason the trust ceremony is: an agent that can
// draft must not also be able to approve its own draft. There is no --yes.
async function ttyConfirm({ text, rawHash, phrase, draftPath, byteLength, input, output }) {
  // Checked before anything is printed, matching approval-service: a scripted
  // caller should get one refusal, not the whole draft echoed into its log
  // followed by a refusal.
  assertInteractiveStreams({
    input,
    output,
    code: 'journal-confirm-requires-tty',
    message:
      'confirming a journal draft requires an interactive terminal; run this yourself, in your own shell',
  });
  output.write([
    '',
    `Draft:  ${draftPath}`,
    `Bytes:  ${byteLength}`,
    `sha256: ${rawHash}`,
    '',
    'These exact bytes will be appended to .noosphere/journal.md:',
    '',
    '---8<---',
    text,
    '--->8---',
    '',
    `Type "${phrase}" to append it, anything else to abort.`,
    '',
  ].join('\n'));
  return readExactConfirmation({
    input,
    output,
    phrase,
    maxBytes: MAX_CONFIRMATION_BYTES,
    ttyCode: 'journal-confirm-requires-tty',
    ttyMessage:
      'confirming a journal draft requires an interactive terminal; run this yourself, in your own shell',
    tooLongCode: 'journal-confirm-input-too-long',
    tooLongMessage: `confirmation exceeds the ${MAX_CONFIRMATION_BYTES}-byte limit`,
  });
}

async function readJournalText(root) {
  const raw = await readBoundedRegularFile(path.join(root, '.noosphere', 'journal.md'), {
    maxBytes: MAX_JOURNAL_BYTES,
  }).catch(() => null);
  return raw === null ? '' : raw.toString('utf8');
}

async function commitLine(root, observation) {
  const head = observation.head.slice(0, SHORT_HEAD);
  const branch = safeOneLine(observation.branch ?? 'detached HEAD', MAX_BRANCH_CHARS);
  const when = safeOneLine(observation.observed_at ?? '', MAX_SUBJECT_CHARS);
  const subject = await commitSubject(root, observation.head);
  return `- \`${head}\` on \`${branch}\`${when ? ` at ${when}` : ''}${subject ? ` — ${subject}` : ''}`;
}

// ponytail: one `git show` per commit rather than a batched `--no-walk`, because
// a single amended-away commit fails a whole batch and this is a manual command
// capped at MAX_DRAFT_COMMITS. A commit that no longer resolves loses its
// subject and keeps its position.
async function commitSubject(root, head) {
  const { stdout } = await execFileAsync(
    'git',
    ['--no-optional-locks', 'show', '-s', '--format=%s', head],
    { cwd: root, maxBuffer: 1_000_000 },
  ).catch(() => ({ stdout: '' }));
  return safeOneLine(stdout, MAX_SUBJECT_CHARS);
}

// A commit subject is repository content: written by anyone who can push, on its
// way into a Markdown file and onto a terminal. normalizeUntrusted removes
// controls, ANSI introducers, bidi overrides and zero-width code points;
// collapsing what survives onto one line is what keeps a crafted `## ` out of
// column 0, where it would forge the header of a separate journal entry.
function safeOneLine(value, maxChars) {
  const flat = normalizeUntrusted(value).replace(/\s+/g, ' ').trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
}
