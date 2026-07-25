// SEC-05 Phase 4B — the trusted in-process owner-approval service (INTERNAL).
//
// This is the ONLY supported way to mint format-2 authority, and the first
// user-facing authority transition in SEC-05. It converts "bytes on disk" into
// "bytes an owner approved" and nothing else may make that conversion:
//
//   - it is not in package.json#exports and no MCP tool or adapter reaches it;
//   - its production confirm() requires an interactive TTY on stdin AND stdout
//     and an exactly-typed phrase — there is no --yes, env, or config bypass, so
//     a prompt-injected agent with non-interactive shell access cannot use it;
//   - the bytes displayed to the owner are produced by the SAME renderer the
//     sinks use (renderSlotBlock), so the owner approves what agents will read;
//   - the commit itself is the audited, locked, journalled format-2 transaction
//     from Phase 4A, unchanged.
//
// Residual risk, accepted and documented: an adversary that can allocate a PTY
// and read its output can type the phrase. The owner's terminal is the trust
// boundary; distinguishing a human keystroke from a PTY writer is not possible
// in-process.
import crypto from 'node:crypto';
import readline from 'node:readline/promises';

import { normalizeUntrusted } from '../memory-safety.js';
import { renderSlotBlock } from '../render.js';
import { TrustStoreError } from '../trust-store-internal.js';
import { APPROVABLE_SLOTS, resolveSlotSource, slotSourcePath } from '../slot-sources.js';
import { FORMAT2_SLOTS, createFormatV2Store } from './trust-format-v2.js';

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function escapeBytesForTerminal(value) {
  return [...Buffer.from(value)].map((byte) =>
    byte >= 0x20 && byte <= 0x7e && byte !== 0x5c
      ? String.fromCharCode(byte)
      : `\\x${byte.toString(16).padStart(2, '0')}`
  ).join('');
}

// The typed phrase binds the confirmation to THIS slot and THESE bytes: a phrase
// captured from an earlier session (or a different slot) does not match, and no
// stray newline / held Enter / `yes |` can satisfy it.
export function confirmationPhrase(slot, rawHash) {
  return `approve ${slot} ${rawHash.slice(0, 8)}`;
}

// Both stdin and stdout must be a terminal: stdin because the owner has to type,
// stdout because they have to read what they are approving. Checked before the
// service touches the trust store at all, so a non-interactive caller leaves no
// trace, and again inside the prompt as defence in depth.
function assertInteractive({ input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || !output.isTTY) {
    throw new TrustStoreError(
      'approval-requires-tty',
      'approving a source requires an interactive terminal; run this yourself, in your own shell',
    );
  }
}

// Production confirmation: interactive terminal only.
async function ttyConfirm({ slot, rawHash, contentHash, byteLength, escapedBytes, rendered, sourcePath }, io) {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  assertInteractive({ input, output });
  const phrase = confirmationPhrase(slot, rawHash);
  output.write([
    '',
    `Slot:        ${slot}`,
    `Source:      ${sourcePath}`,
    `Bytes:       ${byteLength}`,
    `Byte view:   ${escapedBytes}`,
    `rawHash:     ${rawHash}`,
    `contentHash: ${contentHash}`,
    '',
    'These exact bytes will become AUTHORITATIVE instructions for every agent',
    'that reads this project. They are rendered below exactly as agents will',
    'see them:',
    '',
    '---8<---',
    rendered,
    '--->8---',
    '',
    `Type "${phrase}" to approve, anything else to abort.`,
    '',
  ].join('\n'));
  const terminal = readline.createInterface({ input, output });
  try {
    const answer = await terminal.question('> ');
    return answer.trim() === phrase;
  } finally {
    terminal.close();
  }
}

// Approve the current on-disk bytes of one slot. Returns the committed
// transaction; throws TrustStoreError on every refusal (nothing is written
// unless the owner confirmed).
export async function approveSlot({
  projectRoot,
  slot,
  env = process.env,
  secureFileOptions = {},
  confirm,
  input,
  output,
  now,
} = {}) {
  if (!APPROVABLE_SLOTS.includes(slot) || !FORMAT2_SLOTS.includes(slot)) {
    throw new TrustStoreError('invalid-slot', `${slot} cannot be approved; approvable slots: ${APPROVABLE_SLOTS.join(', ')}`);
  }
  // Refuse a non-interactive caller before creating a binding or running
  // recovery: an agent that cannot approve should not be able to touch the trust
  // store at all. (Tests inject `confirm` and are exempt by construction.)
  if (!confirm) assertInteractive({ input, output });
  const source = await resolveSlotSource(projectRoot, slot);
  if (source.bytes.length === 0) {
    // An empty approval authorizes nothing yet burns a generation and an audit
    // event; refuse it rather than record a meaningless authority transition.
    throw new TrustStoreError('approval-empty-slot', `${slot} is empty; there is nothing to approve`);
  }
  const store = createFormatV2Store({ env, secureFileOptions, now });
  const binding = await store.createProjectBinding(projectRoot);
  // Fail closed on a held/foreign/malformed lock or an uncorroborated committed
  // journal BEFORE showing the owner anything to approve.
  await store.recover(binding, slot);

  const approved = await (confirm ?? ((details) => ttyConfirm(details, { input, output })))({
    slot,
    projectRoot,
    sourcePath: escapeBytesForTerminal(slotSourcePath(projectRoot, slot)),
    byteLength: source.bytes.length,
    rawHash: sha256Hex(source.bytes),
    escapedBytes: escapeBytesForTerminal(source.bytes),
    text: source.text,
    // Derived exactly as trust-format-v2 derives the record's contentHash, so the
    // hash shown to the owner is the hash that lands in the record.
    contentHash: sha256Hex(Buffer.from(normalizeUntrusted(source.text), 'utf8')),
    // The owner sees the sink's own rendering of these bytes, not a paraphrase.
    rendered: renderSlotBlock(source.text, { authoritative: true }),
  });
  if (approved !== true) throw new TrustStoreError('approval-declined', 'approval was not confirmed; nothing was changed');

  return store.commitTransaction({ binding, slot, rawBytes: source.bytes, sourceOrigin: `cli:trust-approve:${slot}` });
}
