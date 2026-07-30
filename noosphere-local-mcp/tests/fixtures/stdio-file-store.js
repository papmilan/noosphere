#!/usr/bin/env node

// TEST-ONLY launcher. Not part of the published package and never referenced by
// package.json `bin`. It is the production CLI's startup path with one
// difference: the durable store lives at a caller-supplied path instead of the
// owner's home directory, so the persistence suite can restart a real server
// against a temporary file without touching real user state.
//
// Usage: node tests/fixtures/stdio-file-store.js <state-file>

const file = process.argv[2];
if (!file) {
  process.stderr.write('stdio-file-store: a state file path argument is required\n');
  process.exit(2);
}

let server = null;
let shuttingDown = false;

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    if (server) await server.shutdown();
  } catch {
    /* best effort */
  }
  process.exit(code);
}

process.stdin.on('close', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const { createLocalStdioServer } = await import('../../src/stdio-server.js');
const { FileProjectMemoryRepository } = await import('../../src/file-repository.js');

try {
  server = createLocalStdioServer({ repository: await FileProjectMemoryRepository.open({ file }) });
  await server.start();
} catch (error) {
  process.stderr.write(`stdio-file-store failed to start: ${error && error.message ? error.message : error}\n`);
  process.exit(1);
}
