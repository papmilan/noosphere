const PUBLIC_ERROR_CODES = new Set([
  'invalid-argument',
  'unauthenticated',
  'forbidden',
  'not-found',
  'ambiguous-project',
  'conflict',
  'idempotency-conflict',
  'rate-limited',
  'storage-unavailable',
  'internal',
]);

const INTERNAL_ERROR = Object.freeze({
  isError: true,
  error: Object.freeze({ code: 'internal', retryable: false }),
});

export function toPublicError(error) {
  try {
    if (
      error &&
      typeof error === 'object' &&
      error.isError === true &&
      error.error &&
      typeof error.error === 'object' &&
      Object.keys(error).length === 2 &&
      Object.keys(error.error).length === 2 &&
      typeof error.error.code === 'string' &&
      typeof error.error.retryable === 'boolean' &&
      PUBLIC_ERROR_CODES.has(error.error.code)
    ) {
      return { isError: true, error: { code: error.error.code, retryable: error.error.retryable } };
    }
  } catch {
    // Fall through to the generic public error when structural inspection fails.
  }
  return { isError: true, error: { code: INTERNAL_ERROR.error.code, retryable: INTERNAL_ERROR.error.retryable } };
}
