#!/usr/bin/env node

// Local STDIO entry point. The MCP host launches this process, speaks MCP over
// stdin/stdout, and the process exits when the host closes the stream or sends a
// termination signal. No daemon, no background work, no HTTP, no OIDC.
//
// Lifecycle handlers are registered BEFORE the (heavier) server module is
// imported, so a signal arriving during startup still triggers a clean,
// intercepted exit rather than the OS default terminate.

let server = null;
let shuttingDown = false;

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    if (server) await server.shutdown();
  } catch {
    /* best effort — we are exiting anyway */
  }
  // Nothing else keeps the loop alive; exit cleanly with no leaked handles.
  process.exit(code);
}

// The host closing stdin is the normal end-of-life signal for a STDIO server;
// SIGINT/SIGTERM cover host-initiated termination.
process.stdin.on('close', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const { createLocalStdioServer } = await import('../src/stdio-server.js');
// Always the real system clock. There is no environment or CLI override — a
// fixed clock is supplied only via the injected `now` seam of
// createLocalStdioServer, used by the test-only fixture launcher.
server = createLocalStdioServer();
server.start().catch((error) => {
  process.stderr.write(`noosphere-local-mcp failed to start: ${error && error.message ? error.message : error}\n`);
  process.exit(1);
});
