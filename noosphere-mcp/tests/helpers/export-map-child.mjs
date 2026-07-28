// SEC-05 Phase 4C Task 9 — mutation harness child.
//
// Runs the export-map boundary assertions against an arbitrary package root and
// exits 0 on a clean boundary, 7 on a boundary violation, 1 on anything else.
// The parent test uses it twice: once against an unmutated copy (which must
// pass, proving the harness is wired up) and once against a copy whose export
// map exposes a writer (which must fail, proving the boundary has teeth).
import { assertExportMapBoundary } from './writer-surface.js';

try {
  await assertExportMapBoundary(process.argv[2]);
  process.exit(0);
} catch (error) {
  if (error?.code === 'ERR_WRITER_BOUNDARY') {
    process.stderr.write(`${error.message}\n`);
    process.exit(7);
  }
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exit(1);
}
