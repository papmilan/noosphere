import { APPROVABLE_SLOTS } from '../slot-sources.js';
import { TrustStoreError } from '../trust-store-internal.js';
import {
  assertInteractiveStreams,
  readExactConfirmation,
} from './exact-confirmation.js';
import { createFormatV2Store } from './trust-format-v2.js';

const MAX_CONFIRMATION_BYTES = 256;

function assertInteractive({ input = process.stdin, output = process.stdout } = {}) {
  assertInteractiveStreams({
    input,
    output,
    code: 'revocation-requires-tty',
    message: 'revoking a source requires an interactive terminal',
  });
}

export function revocationPhrase(slot, generation, recordHash) {
  return `revoke ${slot} ${generation} ${recordHash.slice(0, 8)}`;
}

async function ttyConfirm(details, { input = process.stdin, output = process.stdout }) {
  assertInteractive({ input, output });
  const phrase = revocationPhrase(
    details.slot,
    details.generation,
    details.recordHash,
  );
  output.write([
    '',
    `Project identity: ${details.projectIdentityDigest}`,
    `Slot:             ${details.slot}`,
    `Generation:       ${details.generation}`,
    `Record:           ${details.recordId}`,
    `Record hash:      ${details.recordHash}`,
    `rawHash:          ${details.rawHash}`,
    `contentHash:      ${details.contentHash}`,
    '',
    'Revocation appends an authenticated tombstone. Earlier records remain',
    'immutable, but no bytes are authoritative until a fresh approval.',
    '',
    `Type "${phrase}" to revoke, anything else to abort.`,
    '',
  ].join('\n'));
  return readExactConfirmation({
    input,
    output,
    phrase,
    maxBytes: MAX_CONFIRMATION_BYTES,
    ttyCode: 'revocation-requires-tty',
    ttyMessage: 'revoking a source requires an interactive terminal',
    tooLongCode: 'revocation-input-too-long',
    tooLongMessage: 'revocation confirmation exceeds 256 bytes',
  });
}

export async function revokeSlot({
  projectRoot,
  slot,
  env = process.env,
  secureFileOptions = {},
  confirm,
  input,
  output,
  now,
} = {}) {
  if (!APPROVABLE_SLOTS.includes(slot)) {
    throw new TrustStoreError('invalid-slot', `${slot} cannot be revoked`);
  }
  if (!confirm) assertInteractive({ input, output });
  const store = createFormatV2Store({ env, secureFileOptions, now });
  const binding = await store.readProjectBinding(projectRoot);
  const current = await store.classifySlot({ binding, slot });
  if (current.state === 'revoked') {
    return Object.freeze({
      status: 'already-revoked',
      generation: current.generationRecord,
      manifest: await store.readManifest(binding, slot),
    });
  }
  if (current.state !== 'approved') {
    throw new TrustStoreError(
      'revocation-no-approved-generation',
      `${slot} has no approved current generation`,
    );
  }
  const details = Object.freeze({
    projectIdentityDigest: await store.canonicalProjectIdentityDigest(projectRoot),
    slot,
    generation: current.generation,
    recordId: current.recordId,
    recordHash: current.recordHash,
    rawHash: current.generationRecord.rawHash,
    contentHash: current.generationRecord.contentHash,
  });
  const approved = await (confirm ?? (value =>
    ttyConfirm(value, { input, output })))(details);
  if (approved !== true) {
    throw new TrustStoreError(
      'revocation-declined',
      'revocation was not confirmed; nothing was changed',
    );
  }
  return store.commitRevocation({
    binding,
    slot,
    sourceOrigin: `cli:trust-revoke:${slot}`,
    expectedCurrent: Object.freeze({
      state: 'approved',
      generation: current.generation,
      recordId: current.recordId,
      recordHash: current.recordHash,
    }),
  });
}
