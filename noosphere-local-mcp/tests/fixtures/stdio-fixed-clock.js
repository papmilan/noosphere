#!/usr/bin/env node

// TEST-ONLY launcher. Not part of the published package and never referenced by
// package.json `bin`. It exists solely so the transport-parity suite can drive
// the real STDIO server on a deterministic clock, injected through the existing
// `now` dependency of createLocalStdioServer — the same seam the in-process code
// uses. The production CLI (bin/noosphere-local-mcp.js) has no clock override.
//
// Usage: node tests/fixtures/stdio-fixed-clock.js <ISO-8601 instant>

const iso = process.argv[2];
const parsed = Date.parse(iso ?? '');
if (!iso || Number.isNaN(parsed)) {
  process.stderr.write(`stdio-fixed-clock: a valid ISO-8601 timestamp argument is required (got: ${JSON.stringify(iso)})\n`);
  process.exit(2);
}
// Normalize to a canonical ISO string so timestamps are stable regardless of the
// exact argument spelling.
const fixedIso = new Date(parsed).toISOString();

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
// Inject the fixed clock through the ordinary `now` seam — no globals, no
// singleton clock, no production surface.
server = createLocalStdioServer({ now: () => fixedIso });
server.start().catch((error) => {
  process.stderr.write(`stdio-fixed-clock failed to start: ${error && error.message ? error.message : error}\n`);
  process.exit(1);
});
