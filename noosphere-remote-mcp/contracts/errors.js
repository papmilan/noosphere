export const MCP_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: 'invalid-argument',
  UNAUTHENTICATED: 'unauthenticated',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not-found',
  AMBIGUOUS_PROJECT: 'ambiguous-project',
  CONFLICT: 'conflict',
  IDEMPOTENCY_CONFLICT: 'idempotency-conflict',
  RATE_LIMITED: 'rate-limited',
  STORAGE_UNAVAILABLE: 'storage-unavailable',
  INTERNAL: 'internal',
});

const RETRYABLE = new Set([
  MCP_ERROR_CODES.RATE_LIMITED,
  MCP_ERROR_CODES.STORAGE_UNAVAILABLE,
]);

export function createMcpError(code) {
  if (!Object.values(MCP_ERROR_CODES).includes(code)) {
    throw new Error('unknown-error-contract');
  }
  return {
    isError: true,
    error: { code, retryable: RETRYABLE.has(code) },
  };
}
