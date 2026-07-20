import { randomUUID } from 'node:crypto';

const REDACTED = '[redacted]';
const SENSITIVE = /^(authorization|cookie|x-api-key|proxy-authorization)$/i;

export function correlationId() {
  return randomUUID();
}

// Redact sensitive headers so a correlation log never carries a bearer token.
export function redactHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SENSITIVE.test(key) ? REDACTED : value;
  }
  return out;
}

// A structured request log line that never includes credentials or tool
// content — only method, path, status, correlation id, and redacted headers.
export function requestLog({ correlationId: id, method, path, status, headers }) {
  return { correlationId: id, method, path, status, headers: redactHeaders(headers) };
}
