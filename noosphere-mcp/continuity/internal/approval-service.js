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

const MAX_CONFIRMATION_BYTES = 256;

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
  const abort = new AbortController();
  let receivedBytes = 0;
  let inputTooLong = false;
  let lastInputByte;
  const abortOnEnd = () => abort.abort();
  const trackInputBytes = (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    for (const byte of bytes) {
      if (byte === 0x0a) {
        // readline removes CRLF from its answer, so neither delimiter byte is
        // confirmation input.
        if (lastInputByte === 0x0d) receivedBytes -= 1;
        return;
      }
      receivedBytes += 1;
      lastInputByte = byte;
      // Delay only for a possible CRLF delimiter at the exact boundary.
      if (receivedBytes > MAX_CONFIRMATION_BYTES
        && !(receivedBytes === MAX_CONFIRMATION_BYTES + 1 && byte === 0x0d)) {
        inputTooLong = true;
        abort.abort();
        return;
      }
    }
  };
  input.on('data', trackInputBytes);
  input.once('end', abortOnEnd);
  try {
    const answer = await terminal.question('> ', { signal: abort.signal });
    if (Buffer.byteLength(answer, 'utf8') > MAX_CONFIRMATION_BYTES) {
      throw new TrustStoreError(
        'approval-input-too-long',
        `approval confirmation exceeds the ${MAX_CONFIRMATION_BYTES}-byte limit`,
      );
    }
    return answer === phrase;
  } catch (error) {
    if (inputTooLong) {
      throw new TrustStoreError(
        'approval-input-too-long',
        `approval confirmation exceeds the ${MAX_CONFIRMATION_BYTES}-byte limit`,
      );
    }
    if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error?.code === 'ERR_USE_AFTER_CLOSE') {
      return false;
    }
    throw error;
  } finally {
    input.off('data', trackInputBytes);
    input.off('end', abortOnEnd);
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
  const bytes = source.bytes;
  const text = source.text;

  const approved = await (confirm ?? ((details) => ttyConfirm(details, { input, output })))({
    slot,
    projectRoot,
    sourcePath: escapeBytesForTerminal(slotSourcePath(projectRoot, slot)),
    byteLength: bytes.length,
    rawHash: sha256Hex(bytes),
    escapedBytes: escapeBytesForTerminal(bytes),
    text,
    // Derived exactly as trust-format-v2 derives the record's contentHash, so the
    // hash shown to the owner is the hash that lands in the record.
    contentHash: sha256Hex(Buffer.from(normalizeUntrusted(text), 'utf8')),
    // The owner sees the sink's own rendering of these bytes, not a paraphrase.
    rendered: renderSlotBlock(text, { authoritative: true }),
  });
  if (approved !== true) throw new TrustStoreError('approval-declined', 'approval was not confirmed; nothing was changed');

  const store = createFormatV2Store({ env, secureFileOptions, now });
  const binding = await store.createProjectBinding(projectRoot);
  // A confirmed approval still fails closed on held/foreign/malformed locks and
  // uncorroborated committed journals before starting the transaction.
  await store.recover(binding, slot);
  return store.commitTransaction({ binding, slot, rawBytes: bytes, sourceOrigin: `cli:trust-approve:${slot}` });
}
