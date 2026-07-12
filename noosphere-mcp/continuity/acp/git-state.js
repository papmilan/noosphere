import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_ANCESTORS = 2_000;

// observeRepository performs the (impure) Git observation at the boundary.
// classifyCompatibility is a pure function of the snapshot state and a prior
// observation, so freshness decisions are deterministic and testable.

export async function observeRepository(root) {
  const [rootCommit, head, branch, status, ancestors] = await Promise.all([
    git(root, ['rev-list', '--max-parents=0', 'HEAD']).catch(() => ''),
    git(root, ['rev-parse', 'HEAD']).catch(() => ''),
    git(root, ['branch', '--show-current']).catch(() => ''),
    git(root, ['status', '--porcelain=v1']).catch(() => ''),
    git(root, ['rev-list', `--max-count=${MAX_ANCESTORS}`, 'HEAD']).catch(() => ''),
  ]);
  const rootLine = rootCommit.split('\n').filter(Boolean).sort()[0] || '';
  return {
    root_identity: rootLine ? `sha256:${hashHex(rootLine)}` : null,
    head: head || null,
    branch: branch || null,
    dirty: trackedStatusLines(status).length > 0,
    workspace_fingerprint: `sha256:${await workspaceFingerprintHex(root, false)}`,
    ancestors: ancestors.split('\n').filter(Boolean),
  };
}

export function classifyCompatibility(state, observed) {
  const snapshot = state.envelope.repository;
  if (!observed || observed.root_identity == null) {
    return classification('unknown', 3, false, ['repository has no commits to identify']);
  }
  if (snapshot.root_identity !== observed.root_identity) {
    return classification('foreign', 3, false, ['repository root identity differs from the snapshot']);
  }
  if (snapshot.head != null && snapshot.head === observed.head) {
    if (
      snapshot.branch === observed.branch &&
      snapshot.dirty === observed.dirty &&
      snapshot.workspace_fingerprint === observed.workspace_fingerprint
    ) {
      return classification('exact', 0, true, []);
    }
    const reasons = [];
    if (snapshot.branch !== observed.branch) reasons.push('branch differs from the snapshot');
    if (snapshot.workspace_fingerprint !== observed.workspace_fingerprint) reasons.push('working tree changed since the snapshot');
    else if (snapshot.dirty !== observed.dirty) reasons.push('working tree dirty state changed since the snapshot');
    return classification('compatible', 1, true, reasons);
  }
  if (snapshot.head != null && observed.ancestors.includes(snapshot.head)) {
    return classification('advanced', 1, true, ['repository advanced beyond the snapshot head']);
  }
  return classification('diverged', 2, false, ['snapshot head is not an ancestor of the current head']);
}

function classification(status, trustDowngrade, actionable, reasons) {
  return { status, trustDowngrade, actionable, reasons };
}

// Shared with continuity/index.js: a content fingerprint of the tracked working
// tree that ignores Noosphere's own local files.
export async function workspaceFingerprintHex(root, includeJournal = false) {
  const [status, diff, journal] = await Promise.all([
    git(root, ['status', '--porcelain=v1']),
    git(root, ['diff', '--no-ext-diff', '--binary', '--', '.']),
    readFile(path.join(root, '.noosphere', 'journal.md'), 'utf8').catch(() => ''),
  ]);
  const lines = trackedStatusLines(status);
  const untracked = lines.filter((line) => line.startsWith('?? ')).map((line) => line.slice(3));
  const untrackedState = [];
  for (const file of untracked.slice(0, 200)) {
    try {
      const details = await stat(path.join(root, file));
      untrackedState.push(`${file}:${details.size}:${details.mtimeMs}`);
    } catch {
      untrackedState.push(`${file}:missing`);
    }
  }
  return hashHex(
    JSON.stringify({
      status: lines,
      diff,
      untracked: untrackedState,
      journal: includeJournal ? journal : '',
    }),
  );
}

function trackedStatusLines(status) {
  return status.split('\n').filter((line) => line && !line.includes('.noosphere/'));
}

async function git(root, args) {
  const { stdout } = await execFileAsync('git', args, { cwd: root, maxBuffer: 2_000_000 });
  return stdout.trimEnd();
}

function hashHex(value) {
  return createHash('sha256').update(value).digest('hex');
}
