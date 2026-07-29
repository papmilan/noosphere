import { usageError } from '../security-cli-error.js';
import { REPLAY_SLOTS } from './constants.js';

const SLOT_SET = new Set(REPLAY_SLOTS);

export function parseReplayArgs(args) {
  if (!Array.isArray(args) || args.includes('--')) {
    throw usageError('invalid replay command');
  }
  if (args.length === 1 && args[0] === 'status') {
    return Object.freeze({ verb: 'status' });
  }
  if (args[0] !== 'list') {
    throw usageError('invalid replay command');
  }
  let slot;
  let limit = 100;
  const seen = new Set();
  for (let index = 1; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (
      !['--slot', '--limit'].includes(option) ||
      seen.has(option) ||
      value === undefined ||
      value.startsWith('--')
    ) {
      throw usageError('invalid replay list options');
    }
    seen.add(option);
    if (option === '--slot') {
      if (!SLOT_SET.has(value)) {
        throw usageError('invalid replay slot');
      }
      slot = value;
    } else {
      if (!/^[1-9][0-9]*$/.test(value)) {
        throw usageError('invalid replay list limit');
      }
      limit = Number(value);
      if (!Number.isSafeInteger(limit) || limit > 100) {
        throw usageError('invalid replay list limit');
      }
    }
  }
  return Object.freeze({
    verb: 'list',
    ...(slot === undefined ? {} : { slot }),
    limit,
  });
}
