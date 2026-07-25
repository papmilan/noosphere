import { readFile } from 'node:fs/promises';
import path from 'node:path';

// SEC-05 Phase 4B — the single derivation of the bytes an authority-capable slot
// is made of.
//
// The owner approves bytes; a sink renders bytes. If those two derivations ever
// drift, the owner authorizes one thing and the agent reads another (the M-2
// class of defect closed in Phase 3 for the baseline slot). This module is the
// one place either side may derive slot bytes from, so drift is a diff conflict
// rather than a silent authority bug.
//
// INTERNAL: not listed in package.json#exports. Sinks and the approval service
// import it by relative path.

export const APPROVABLE_SLOTS = Object.freeze(['master-prompt', 'instructions', 'baseline']);

const SLOT_FILES = Object.freeze({
  'master-prompt': ['.noosphere', 'master-prompt.md'],
  instructions: ['.noosphere', 'instructions.md'],
  baseline: ['.noosphere', 'baseline.md'],
});

// The baseline file carries a generated header that is NOT part of the rendered
// block; refreshContext strips it before rendering, so trust must bind the
// stripped body. Exported so the sink and the approval service share this exact
// expression instead of each writing their own.
export function baselineBody(text) {
  return String(text ?? '').replace(/^# Noosphere project baseline\s*/i, '').trim();
}

// Reads the on-disk bytes for a slot exactly as its sink will use them. Returns
// '' for a missing/unreadable file (callers treat empty as "nothing to approve"
// / "nothing to gate"), never throws for absence.
export async function resolveSlotBytes(root, slot) {
  const segments = SLOT_FILES[slot];
  if (!segments) return '';
  const text = await readFile(path.join(root, ...segments), 'utf8').catch(() => '');
  return slot === 'baseline' ? baselineBody(text) : text;
}

export function slotSourcePath(root, slot) {
  const segments = SLOT_FILES[slot];
  return segments ? path.join(root, ...segments) : null;
}
