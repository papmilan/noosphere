import { lstat, readFile } from 'node:fs/promises';
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

const UTF8 = new TextDecoder('utf-8', { fatal: true });

// The baseline file carries a generated header that is NOT part of the rendered
// block; refreshContext strips it before rendering, so trust must bind the
// stripped body. Exported so the sink and the approval service share this exact
// expression instead of each writing their own.
export function baselineBody(text) {
  return String(text ?? '').replace(/^# Noosphere project baseline\s*/i, '').trim();
}

// Reads the on-disk bytes for a slot exactly as its sink will use them. Absence
// is an empty source; malformed input is refused instead of being silently
// replaced with U+FFFD before the approval and sink paths can disagree.
export async function resolveSlotSource(root, slot) {
  const segments = SLOT_FILES[slot];
  if (!segments) return { bytes: Buffer.alloc(0), text: '' };
  const file = path.join(root, ...segments);

  // Decide WHAT the path is before opening it. Opening blindly lets a
  // working-tree writer hand us something that never returns: `mkfifo
  // .noosphere/instructions.md` makes readFile block forever — no error code is
  // ever produced, so no amount of error classification helps, and refresh/watch
  // hang instead of failing. lstat (not stat) so a symlink is judged as a
  // symlink rather than as its target.
  const stats = await lstat(file).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (stats === null) return { bytes: Buffer.alloc(0), text: '' };
  if (!stats.isFile()) {
    const error = new Error(`${slot} is not a regular file`);
    // A directory keeps its familiar code; every other non-regular object
    // (FIFO, socket, block/char device, symlink) reports as one class.
    error.code = stats.isDirectory() ? 'EISDIR' : 'slot-not-regular-file';
    throw error;
  }

  const fileBytes = await readFile(file).catch((error) => {
    if (error.code === 'ENOENT') return Buffer.alloc(0);
    throw error;
  });
  let fileText;
  try {
    fileText = UTF8.decode(fileBytes);
  } catch {
    const error = new Error(`${slot} is not valid UTF-8`);
    error.code = 'slot-invalid-utf8';
    throw error;
  }
  const text = slot === 'baseline' ? baselineBody(fileText) : fileText;
  return { bytes: Buffer.from(text, 'utf8'), text };
}

// The failure modes a working-tree writer can force on a slot file: the content
// is unusable, but the FILE is there. Anything outside this set (EIO, ENOMEM, an
// unrecognised code) is a real fault and still throws — degrading on unknown
// errors would hide genuine breakage behind a silently empty slot.
export const UNUSABLE_SOURCE_CODES = new Set([
  'slot-invalid-utf8', // decodes to nothing a sink could render
  'slot-not-regular-file', // FIFO, socket, device, symlink — never opened
  'EISDIR', // a directory planted at the slot path
  'ENOTDIR', // a file planted where a path component must be a directory
  'ELOOP', // symlink loop
  'EACCES', // permissions revoked
  'EPERM',
]);

// READ-ONLY render/watch paths only. Malformed or unreadable slot content must
// not take down refresh/watch or the Ollama sink: anything with write access to
// the working tree can plant one bad byte, and a hard throw turns that into a
// denial of service.
//
// The result carries `unusable` so callers can tell PRESENT-BUT-UNUSABLE from
// ABSENT. They are not interchangeable: refreshContext treats an absent slot as
// grounds to restore remote Walrus content, and a tree writer must not be able
// to trigger that by corrupting the local file. Authority is unaffected either
// way — the bytes are empty and isSlotAuthoritative rejects empty outright.
//
// Approval, capture, and every other write path keep the strict
// resolveSlotSource refusal, so an owner is never asked to approve bytes a sink
// could not have rendered, and no writer ever mistakes a corrupt slot for a
// missing one.
export async function resolveSlotSourceForRead(root, slot) {
  try {
    return { ...await resolveSlotSource(root, slot), unusable: false };
  } catch (error) {
    if (UNUSABLE_SOURCE_CODES.has(error.code)) {
      return { bytes: Buffer.alloc(0), text: '', unusable: true, reason: error.code };
    }
    throw error;
  }
}

// Compatibility surface for callers that only need the sink text.
export async function resolveSlotBytes(root, slot) {
  return (await resolveSlotSource(root, slot)).text;
}

export function slotSourcePath(root, slot) {
  const segments = SLOT_FILES[slot];
  return segments ? path.join(root, ...segments) : null;
}
