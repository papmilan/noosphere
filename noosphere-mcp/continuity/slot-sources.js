import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { readBoundedRegularFile } from './secure-fs.js';

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

// SEC-05 Phase 4B-R4 — the source-size bound for an authority-capable slot.
//
// 1 MiB. These three files are hand-written (or, for the baseline, generated
// from at most 200 commit subjects) markdown that an owner reads in a terminal
// before approving and that every agent then carries in its context window; a
// megabyte is already an order of magnitude past anything usable there, so the
// bound refuses only inputs that were never legitimate. It exists for
// availability, not policy: without it `mkfile -n 8g .noosphere/master-prompt.md`
// — one sparse file any working-tree writer can create in milliseconds — makes
// every refresh, watch tick, and approval allocate 8 GiB. Deliberately a
// constant and not configurable: an env-tunable security bound is a downgrade
// switch, and nothing legitimate needs to raise it.
export const MAX_SLOT_SOURCE_BYTES = 1024 * 1024;

// SEC-05 Phase 4B-R4 — the symlink policy for slot files, chosen deliberately.
//
// POLICY: a slot file that IS a symlink is REJECTED (never followed, never
// opened). A slot file reached THROUGH a symlinked parent directory is
// SUPPORTED and read normally.
//
// Why reject the file: the slot path is the one thing an owner is told they are
// approving. Following a symlink there means `.noosphere/master-prompt.md` can
// name bytes anywhere the process can read — /etc, another checkout, a device —
// and the displayed source path would still say `.noosphere/master-prompt.md`.
// Refusing keeps "the slot file" and "the bytes" the same object. This is
// enforced twice: lstat classifies it below, and O_NOFOLLOW in
// readBoundedRegularFile refuses it at the kernel even if the path is swapped
// after that classification.
//
// Why support symlinked parents: a symlinked parent redirects the whole project
// tree, not one authority-capable file, and it is ordinary infrastructure —
// macOS /tmp is a symlink to /private/tmp, and git worktrees, container mounts,
// and home-directory relocations all produce them. Rejecting them would break
// real installs to prevent an attack that a symlinked parent does not enable:
// anyone who can repoint the parent directory can equally rewrite the file in
// place, and neither makes bytes authoritative — approval binds exact bytes
// through a separate interactive transition.
//
// COMPATIBILITY: this is a behaviour change from pre-Phase-4B, which followed a
// symlinked slot file. See SECURITY.md.

// The primitive's vocabulary is filesystem-level; slots have their own. Mapped
// here so exactly one place knows both.
const SOURCE_ERROR_CODES = Object.freeze({
  'state-file-symlink': 'slot-not-regular-file',
  'state-file-not-regular': 'slot-not-regular-file',
  'state-file-too-large': 'slot-too-large',
  'state-file-changed': 'slot-changed-during-read',
});

function slotError(slot, code, detail) {
  const error = new Error(`${slot} ${detail}`);
  error.code = code;
  return error;
}

// The baseline file carries a generated header that is NOT part of the rendered
// block; refreshContext strips it before rendering, so trust must bind the
// stripped body. Exported so the sink and the approval service share this exact
// expression instead of each writing their own.
export function baselineBody(text) {
  return String(text ?? '').replace(/^# Noosphere project baseline\s*/i, '').trim();
}

// Reads the on-disk bytes for a slot exactly as its sink will use them.
//
// `present` distinguishes ABSENT from PRESENT-BUT-EMPTY; a thrown
// UNUSABLE_SOURCE_CODES error is the third state, PRESENT-BUT-UNUSABLE. Callers
// that collapse those three lose real information — see refreshContext (which
// must not restore remote content over a corrupt local file) and printProtocol
// (which must not answer an absent protocol with zero bytes and exit 0).
export async function resolveSlotSource(root, slot) {
  const segments = SLOT_FILES[slot];
  if (!segments) return { bytes: Buffer.alloc(0), text: '', present: false };
  const file = path.join(root, ...segments);

  // Classification only. lstat (not stat) so a symlink is judged as a symlink
  // rather than as its target, and so a directory keeps its familiar EISDIR
  // while every other non-regular object reports as one class. The SECURITY
  // guarantee is not here — this stat can be stale by the time the file is
  // opened — it is in readBoundedRegularFile, which judges the descriptor it
  // actually opened. This exists so the refusal names the shape the owner
  // planted instead of a generic errno.
  const stats = await lstat(file).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (stats === null) return { bytes: Buffer.alloc(0), text: '', present: false };
  if (!stats.isFile()) {
    throw slotError(slot, stats.isDirectory() ? 'EISDIR' : 'slot-not-regular-file', 'is not a regular file');
  }

  // O_NOFOLLOW + O_NONBLOCK + fstat-after-open + size-bound + bounded read. A
  // FIFO swapped in after the lstat above opens instead of blocking and is then
  // refused by type; an oversized (including sparse) file is refused before a
  // byte is allocated.
  let fileBytes;
  try {
    fileBytes = await readBoundedRegularFile(file, { maxBytes: MAX_SLOT_SOURCE_BYTES });
  } catch (error) {
    const mapped = SOURCE_ERROR_CODES[error.code];
    if (!mapped) throw error;
    throw slotError(slot, mapped, error.message);
  }
  // Raced with a delete between the lstat and the open: genuinely absent now.
  if (fileBytes === null) return { bytes: Buffer.alloc(0), text: '', present: false };

  let fileText;
  try {
    fileText = UTF8.decode(fileBytes);
  } catch {
    throw slotError(slot, 'slot-invalid-utf8', 'is not valid UTF-8');
  }
  const text = slot === 'baseline' ? baselineBody(fileText) : fileText;
  return { bytes: Buffer.from(text, 'utf8'), text, present: true };
}

// The failure modes a working-tree writer can force on a slot file: the content
// is unusable, but the FILE is there. Anything outside this set (EIO, ENOMEM, an
// unrecognised code) is a real fault and still throws — degrading on unknown
// errors would hide genuine breakage behind a silently empty slot.
export const UNUSABLE_SOURCE_CODES = new Set([
  'slot-invalid-utf8', // decodes to nothing a sink could render
  'slot-not-regular-file', // FIFO, socket, device, symlink — never opened
  'slot-too-large', // past MAX_SLOT_SOURCE_BYTES — refused before allocation
  'slot-changed-during-read', // grew past its own fstat mid-read
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
      // PRESENT, and it stays present: `present: true` is what stops a renderer
      // reporting "nothing was recorded" and what stops refreshContext pulling
      // remote content over local owner content that merely became unreadable.
      return { bytes: Buffer.alloc(0), text: '', present: true, unusable: true, reason: error.code };
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
