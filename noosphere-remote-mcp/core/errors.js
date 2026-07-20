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
    if (error && typeof error === 'object' && error.isError === true) {
      // Snapshot each hostile-controlled field exactly once. A malicious getter
      // that returns different values on successive reads cannot pass validation
      // with one value and leak another into the returned object.
      const inner = error.error;
      if (inner && typeof inner === 'object') {
        const code = inner.code;
        const retryable = inner.retryable;
        if (
          Object.keys(error).length === 2 &&
          Object.keys(inner).length === 2 &&
          typeof code === 'string' &&
          typeof retryable === 'boolean' &&
          PUBLIC_ERROR_CODES.has(code)
        ) {
          return { isError: true, error: { code, retryable } };
        }
      }
    }
  } catch {
    // Fall through to the generic public error when structural inspection fails.
  }
  return { isError: true, error: { code: INTERNAL_ERROR.error.code, retryable: INTERNAL_ERROR.error.retryable } };
}
