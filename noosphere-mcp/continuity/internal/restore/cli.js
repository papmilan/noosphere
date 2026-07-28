import { randomBytes } from 'node:crypto';

import { usageError } from '../security-cli-error.js';
import { CANDIDATE_ID_PATTERN, RESTORE_SLOTS } from './constants.js';

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const BASE32_VALUES = new Map(
  [...BASE32_ALPHABET].map((character, index) => [character, index]),
);

export function encodeLowerBase32(value) {
  const bytes = Buffer.from(value);
  let accumulator = 0;
  let bits = 0;
  let encoded = '';
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += BASE32_ALPHABET[(accumulator >>> bits) & 31];
      accumulator &= (1 << bits) - 1;
    }
  }
  if (bits > 0) encoded += BASE32_ALPHABET[(accumulator << (5 - bits)) & 31];
  return encoded;
}

export function decodeCanonicalCandidateId(candidateId) {
  if (typeof candidateId !== 'string' ||
      !CANDIDATE_ID_PATTERN.test(candidateId)) {
    throw usageError('candidate ID must be canonical lowercase base32');
  }
  let accumulator = 0;
  let bits = 0;
  const bytes = [];
  for (const character of candidateId) {
    accumulator = (accumulator << 5) | BASE32_VALUES.get(character);
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 0xff);
      accumulator &= (1 << bits) - 1;
    }
  }
  const decoded = Buffer.from(bytes);
  if (decoded.length !== 32 || bits !== 4 || accumulator !== 0 ||
      encodeLowerBase32(decoded) !== candidateId) {
    throw usageError('candidate ID is not canonical 256-bit base32');
  }
  return decoded;
}

export function generateCandidateId(random = randomBytes) {
  const bytes = Buffer.from(random(32));
  if (bytes.length !== 32) {
    throw new TypeError('candidate randomness must contain exactly 32 bytes');
  }
  return encodeLowerBase32(bytes);
}

export function parseRestoreArgs(args) {
  if (!Array.isArray(args) || args.includes('--')) {
    throw usageError('invalid restore command');
  }
  const [verb, value] = args;
  if (verb === 'stage' &&
      args.length === 2 &&
      Object.hasOwn(RESTORE_SLOTS, value)) {
    return Object.freeze({ verb, slot: value });
  }
  // `recover` takes no argument on purpose: it completes transactions that
  // already exist and cannot select, create, or target one.
  if ((verb === 'list' || verb === 'recover') && args.length === 1) {
    return Object.freeze({ verb });
  }
  if ((verb === 'show' || verb === 'apply') && args.length === 2) {
    decodeCanonicalCandidateId(value);
    return Object.freeze({ verb, candidateId: value });
  }
  throw usageError('invalid restore command');
}
