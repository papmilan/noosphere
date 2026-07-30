import { TrustStoreError } from '../trust-store-internal.js';

const OWNER_REFUSAL_CODES = new Set([
  'approval-declined',
  'approval-input-too-long',
  'revocation-declined',
  'revocation-input-too-long',
  'migration-declined',
  'migration-input-too-long',
  'restore-declined',
  'restore-input-too-long',
]);

export class SecurityCliError extends Error {
  constructor(code, message, exitCode) {
    super(message);
    this.name = 'SecurityCliError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

export function exitCodeForError(error) {
  if (error instanceof SecurityCliError &&
      Number.isInteger(error.exitCode) &&
      error.exitCode >= 1 &&
      error.exitCode <= 4) {
    return error.exitCode;
  }
  if (error?.code === 'ERR_CLI_USAGE') return 2;
  if (OWNER_REFUSAL_CODES.has(error?.code)) return 3;
  if (error instanceof TrustStoreError ||
      String(error?.code ?? '').startsWith('ERR_TRUST_') ||
      String(error?.code ?? '').startsWith('ERR_RESTORE_')) {
    return 4;
  }
  return 1;
}

export function usageError(message) {
  return new SecurityCliError('ERR_CLI_USAGE', message, 2);
}
