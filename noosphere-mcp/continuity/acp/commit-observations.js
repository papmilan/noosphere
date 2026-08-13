import path from 'node:path';

import { atomicOwnerOnlyWrite, readBoundedRegularFile } from '../secure-fs.js';
import { ensureRuntimeStateIgnored } from '../csp/storage.js';
import { observeRepository } from './git-state.js';

// A commit observation records where the tree WAS. It carries no step, no
// status, and no target file, because a git hook has nobody to state an intent
// and this design does not invent one — see
// docs/design/specs/2026-08-12-inferred-continuity.md §4.1.
//
// This deliberately does not reuse the ACP execution envelope. That schema
// requires a `cursor` with a step_id, an in-progress `status`, and a target
// file: it describes goals, and filling those from a hook would fabricate the
// intent the spec refuses to guess at. Position and intent are different
// records, so they get different shapes.
const OBSERVATIONS = 'commit-observations.json';
const SCHEMA = 'noosphere.commit-observations';
const VERSION = 1;

// Bounded so a busy repository cannot grow this without limit. Oldest entries
// are dropped first; this is a breadcrumb trail, not an audit log, and nothing
// downstream may treat a missing entry as evidence that a commit did not exist.
const MAX_OBSERVATIONS = 500;

// ponytail: whole-file rewrite rather than an append, because the bound needs
// the existing entries anyway. At 500 small records this is well under a
// millisecond; revisit only if the cap grows by orders of magnitude.

export function observationsPath(root) {
  return path.join(root, '.noosphere', OBSERVATIONS);
}

export async function readCommitObservations(root) {
  const raw = await readBoundedRegularFile(observationsPath(root), {
    maxBytes: 512 * 1024,
  }).catch(() => null);
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    if (parsed?.schema !== SCHEMA || !Array.isArray(parsed.observations)) return [];
    return parsed.observations;
  } catch {
    // A corrupt telemetry file must never fail a command that only wanted to
    // read history. It is rebuilt from the next commit onward.
    return [];
  }
}

/**
 * Records the measured repository position at `now`. Returns the observation
 * that was stored, or null when there is no HEAD to observe (an empty
 * repository), which is a skip rather than a failure.
 */
export async function recordCommitObservation(root, now, { source = 'git-hook' } = {}) {
  // Before the deduplication below, not after it: this runs from a hook in
  // projects that never edited a .gitignore for this file, and a repeat
  // observation of an already-recorded position returns early. Refreshing the
  // exclude only on the writing path leaves a file written by an older build
  // untracked-but-visible forever, because every later run is a duplicate.
  await ensureRuntimeStateIgnored(root);
  const observed = await observeRepository(root);
  if (!observed.head) return null;
  const observation = {
    observed_at: now,
    source,
    head: observed.head,
    branch: observed.branch,
    dirty: observed.dirty,
    workspace_fingerprint: observed.workspace_fingerprint,
    root_identity: observed.root_identity,
  };
  const existing = await readCommitObservations(root);
  // Re-running the hook on the same commit with an unchanged tree is a repeat
  // observation of one position, not a second event.
  const duplicate = existing.at(-1);
  if (
    duplicate?.head === observation.head &&
    duplicate?.workspace_fingerprint === observation.workspace_fingerprint
  ) {
    return duplicate;
  }
  const observations = [...existing, observation].slice(-MAX_OBSERVATIONS);
  await atomicOwnerOnlyWrite(
    observationsPath(root),
    `${JSON.stringify({ schema: SCHEMA, version: VERSION, observations }, null, 2)}\n`,
    { root },
  );
  return observation;
}
