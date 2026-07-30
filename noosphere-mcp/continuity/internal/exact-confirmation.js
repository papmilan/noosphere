import readline from 'node:readline/promises';

import { TrustStoreError } from '../trust-store-internal.js';

export function assertInteractiveStreams({
  input = process.stdin,
  output = process.stdout,
  code,
  message,
}) {
  if (!input.isTTY || !output.isTTY) {
    throw new TrustStoreError(code, message);
  }
}

export async function readExactConfirmation({
  input = process.stdin,
  output = process.stdout,
  phrase,
  maxBytes,
  ttyCode,
  ttyMessage,
  tooLongCode,
  tooLongMessage,
}) {
  assertInteractiveStreams({
    input,
    output,
    code: ttyCode,
    message: ttyMessage,
  });
  const terminal = readline.createInterface({ input, output });
  const abort = new AbortController();
  let receivedBytes = 0;
  let inputTooLong = false;
  let lastInputByte;
  const abortOnEnd = () => abort.abort();
  const trackInputBytes = chunk => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    for (const byte of bytes) {
      if (byte === 0x0a) {
        if (lastInputByte === 0x0d) receivedBytes -= 1;
        return;
      }
      receivedBytes += 1;
      lastInputByte = byte;
      if (receivedBytes > maxBytes &&
          !(receivedBytes === maxBytes + 1 && byte === 0x0d)) {
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
    if (Buffer.byteLength(answer, 'utf8') > maxBytes) {
      throw new TrustStoreError(tooLongCode, tooLongMessage);
    }
    return answer === phrase;
  } catch (error) {
    if (inputTooLong) {
      throw new TrustStoreError(tooLongCode, tooLongMessage);
    }
    if (error?.name === 'AbortError' ||
        error?.code === 'ABORT_ERR' ||
        error?.code === 'ERR_USE_AFTER_CLOSE') {
      return false;
    }
    throw error;
  } finally {
    input.off('data', trackInputBytes);
    input.off('end', abortOnEnd);
    terminal.close();
  }
}
