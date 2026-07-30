// SEC-05 Phase 4C Task 9 — the authority-writer surface inventory.
//
// This is the single machine-readable statement of which functions mutate
// authority state, which module owns each one, and which production surfaces
// are allowed to reach them. `restore-boundary.test.js` asserts the boundary
// against this inventory; `phase4c-conformance.test.js` re-uses the same
// inventory so the gate and the regression suite can never disagree.
//
// Adding a writer without adding it here is itself caught: `WRITER_MODULES`
// is asserted to be an exact partition of every mutating export of every
// listed module, so a new export in a writer module fails the boundary suite
// until it is classified.
import fs from 'node:fs/promises';
import path from 'node:path';

// Every authority mutation primitive, grouped by the audit category it belongs
// to. Paths are POSIX-relative to the noosphere-mcp package root.
export const WRITER_MODULES = Object.freeze({
  approval: Object.freeze({
    module: 'continuity/internal/approval-service.js',
    writers: Object.freeze(['approveSlot']),
  }),
  revocation: Object.freeze({
    module: 'continuity/internal/revocation-service.js',
    writers: Object.freeze(['revokeSlot']),
  }),
  migration: Object.freeze({
    module: 'continuity/internal/migration-service.js',
    writers: Object.freeze(['migrateTrustInventory']),
  }),
  restoreStaging: Object.freeze({
    module: 'continuity/internal/restore/candidate-store.js',
    writers: Object.freeze([
      'cleanupExpiredCandidates',
      'consumeCandidate',
      'createRestoreCandidateFromSource',
      'markApplyInProgress',
      'stageRestoreCandidate',
    ]),
  }),
  replayRestoreStaging: Object.freeze({
    module: 'continuity/internal/replay/restore-stage.js',
    writers: Object.freeze(['stageReplayAwareRestoreCandidate']),
  }),
  restoreApply: Object.freeze({
    module: 'continuity/internal/restore/apply-service.js',
    writers: Object.freeze(['applyRestoreCandidate']),
  }),
  confirmation: Object.freeze({
    module: 'continuity/internal/restore/confirmation-store.js',
    writers: Object.freeze(['confirmContext', 'issueConfirmation', 'spendContext']),
  }),
  receipt: Object.freeze({
    module: 'continuity/internal/restore/receipt-store.js',
    // commitConsumedMarker is the consumed-marker writer; it shares a module
    // with the receipt writer, so both are declared here and the consumed-marker
    // category below names it again for the audit report.
    writers: Object.freeze(['commitConsumedMarker', 'commitRestoreReceipt']),
  }),
  recovery: Object.freeze({
    module: 'continuity/internal/restore/recovery.js',
    writers: Object.freeze(['recoverRestoreTransactions']),
  }),
  journal: Object.freeze({
    module: 'continuity/internal/restore/apply-journal.js',
    writers: Object.freeze(['appendApplyJournalState', 'createApplyJournal']),
  }),
  stateMachine: Object.freeze({
    module: 'continuity/internal/restore/state-machine.js',
    writers: Object.freeze(['createStateMachine', 'transitionStateMachine']),
  }),
  formatV2: Object.freeze({
    module: 'continuity/internal/trust-format-v2.js',
    writers: Object.freeze(['createFormatV2Store']),
  }),
  trustPrimitives: Object.freeze({
    module: 'continuity/trust-store-internal.js',
    writers: Object.freeze(['ensureMachineKey', 'ensureProjectIdentity', 'putSlotRecord']),
  }),
});

// The non-mutating exports of each writer module. Declared so that the union of
// `writers` and these is asserted to equal the module's ACTUAL export list: a
// newly added export is neither silently trusted as a reader nor silently
// ignored — it fails the boundary suite until someone classifies it.
export const READ_ONLY_EXPORTS = Object.freeze({
  'continuity/internal/approval-service.js': Object.freeze([
    'confirmationPhrase',
    'escapeBytesForTerminal',
  ]),
  'continuity/internal/revocation-service.js': Object.freeze(['revocationPhrase']),
  'continuity/internal/migration-service.js': Object.freeze([]),
  'continuity/internal/restore/candidate-store.js': Object.freeze([
    'listApplyInProgressCandidates',
    'listRestoreCandidates',
    'matchRestoreCandidateByTuple',
    'readCandidateState',
    'showRestoreCandidate',
  ]),
  'continuity/internal/replay/restore-stage.js': Object.freeze([]),
  'continuity/internal/restore/apply-service.js': Object.freeze([]),
  'continuity/internal/restore/confirmation-store.js': Object.freeze([
    'confirmationPhrase',
    'readConfirmation',
  ]),
  'continuity/internal/restore/receipt-store.js': Object.freeze([
    'classifyRestoreReceipt',
    'readConsumedMarker',
    'readRestoreReceipt',
  ]),
  // classifyLockLiveness is a pure classifier over an already-authenticated
  // lock: it reads no file, mutates nothing, and returns one of three verdicts.
  'continuity/internal/restore/recovery.js': Object.freeze(['classifyLockLiveness']),
  'continuity/internal/restore/apply-journal.js': Object.freeze([
    'APPLY_JOURNAL_STATES',
    'APPLY_TRANSITIONS',
    'assertNextApplyState',
    'listApplyJournals',
    'readApplyJournal',
    'temporaryRelativePath',
    'validDestinationBinding',
    'validManifestBinding',
  ]),
  'continuity/internal/restore/state-machine.js': Object.freeze([
    'APPLY_JOURNAL_STATES',
    'APPLY_TRANSITIONS',
    'CANDIDATE_TRANSITIONS',
    'CONFIRMATION_TRANSITIONS',
    'assertTransition',
    'readStateMachine',
  ]),
  'continuity/internal/trust-format-v2.js': Object.freeze([
    'FORMAT',
    'FORMAT2_SLOTS',
    'JOURNAL_STATES',
  ]),
  'continuity/trust-store-internal.js': Object.freeze([
    'MACHINE_KEY_BYTES',
    'MACHINE_KEY_HEX_LENGTH',
    'MAX_TRUST_RECORD_BYTES',
    'PHASE1_NORM_ALGO',
    'PHASE1_NORM_VERSION',
    'TRUST_SLOTS',
    'TrustStoreError',
    'canonicalize',
    'homeDir',
    'isSlotAuthoritative',
    'machineKeyId',
    'ownerScope',
    'readRecord',
  ]),
});

// The consumed-marker writer lives in the receipt module. Named separately so
// the audit report can list all eight required categories independently.
export const CONSUMED_MARKER_WRITER = Object.freeze({
  module: 'continuity/internal/restore/receipt-store.js',
  writers: Object.freeze(['commitConsumedMarker']),
});

// Mutation primitives reached through an object rather than a named export:
// createFormatV2Store() returns a frozen facade whose methods commit authority.
// Requirement 9 exists because of exactly this shape.
export const FORMAT_V2_STORE_MUTATORS = Object.freeze([
  'acquireLock',
  'commitApproval',
  'commitRevocation',
  'commitTransaction',
  'createProjectBinding',
  'recover',
]);

export const WRITER_MODULE_PATHS = Object.freeze(
  [...new Set(Object.values(WRITER_MODULES).map((entry) => entry.module))].sort(),
);

// The writer modules a caller can drive end to end: importing one of these is
// importing the whole owner ceremony, so only the CLI entry module may.
export const MUTATION_ENTRY_MODULES = Object.freeze([
  'continuity/internal/approval-service.js',
  'continuity/internal/migration-service.js',
  'continuity/internal/restore/apply-service.js',
  'continuity/internal/replay/restore-stage.js',
  // Phase 4C remediation: recovery is a production entry point now — the apply
  // verb runs it before every transaction, and `restore recover` runs it alone.
  'continuity/internal/restore/recovery.js',
  'continuity/internal/revocation-service.js',
]);

// The remaining writer modules are collaborators of those entry points. They
// also carry widely-used read-only exports (TrustStoreError, canonicalize,
// FORMAT2_SLOTS), so their import is permitted inside the internal graph and
// from the public authority gate — and nowhere else.
export const PRIMITIVE_MODULES = Object.freeze(
  WRITER_MODULE_PATHS.filter((entry) => !MUTATION_ENTRY_MODULES.includes(entry)),
);

// The only non-internal modules allowed to import a primitive module.
export const PRIMITIVE_IMPORT_ALLOWLIST = Object.freeze([
  'continuity/index.js',
  'continuity/trust-store.js',
]);

export const ALL_WRITER_NAMES = Object.freeze(
  [...new Set(Object.values(WRITER_MODULES).flatMap((entry) => entry.writers))].sort(),
);

// The complete, exact public surface of the package. Anything else is a
// regression, whether or not its name looks like a writer.
export const PUBLIC_EXPORT_PATHS = Object.freeze(['./package.json', './trust-store']);
export const PUBLIC_TRUST_STORE_EXPORTS = Object.freeze([
  'PHASE1_NORM_ALGO',
  'PHASE1_NORM_VERSION',
  'TRUST_SLOTS',
  'TrustStoreError',
  'isSlotAuthoritative',
]);

// The only production module allowed to import a mutation entry point, and the
// only functions inside it allowed to call one.
export const CLI_ENTRY_MODULE = 'continuity/index.js';
export const CLI_MUTATION_FUNCTIONS = Object.freeze(['restoreFromCli', 'trustFromCli']);
export const CLI_MUTATION_SUBCOMMANDS = Object.freeze([
  'cli:restore apply',
  'cli:restore recover',
  'cli:restore stage',
  'cli:trust approve',
  'cli:trust migrate',
  'cli:trust revoke',
]);

// Production surfaces that must never reach a writer. Directories are relative
// to the repository root so sibling packages (relayer, MCP servers) are covered
// by the same scan.
export const FORBIDDEN_SURFACES = Object.freeze({
  mcp: Object.freeze([
    'noosphere-mcp/mcp-server',
    'noosphere-local-mcp/bin',
    'noosphere-local-mcp/src',
    'noosphere-remote-mcp/contracts',
    'noosphere-remote-mcp/core',
    'noosphere-remote-mcp-server/src',
  ]),
  lifecycle: Object.freeze(['noosphere-mcp/lifecycle']),
  hooks: Object.freeze(['noosphere-mcp/hooks']),
  relayer: Object.freeze(['noosphere-relayer']),
});

const SKIP_DIRECTORIES = new Set(['node_modules', 'tests', '.git', 'coverage']);
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.mdc']);

/** Recursively lists source files under `absolute`, skipping tests and deps. */
export async function listSourceFiles(absolute) {
  const found = [];
  const entries = await fs.readdir(absolute, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const child = path.join(absolute, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      found.push(...(await listSourceFiles(child)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) found.push(child);
  }
  return found.sort();
}

// Import specifiers only. A writer's NAME may legitimately appear in a comment
// (continuity/trust-store.js documents which writers it deliberately withholds),
// so a mention-based scan would be both noisy and unsound — the boundary that
// matters is whether the module graph can reach the writer.
const IMPORT_PATTERNS = [
  /\bimport\s+[^'";]*?from\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bexport\s+[^'";]*?from\s*['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bcreateRequire\([^)]*\)[^;]*?['"]([^'"]+)['"]/g,
];

/** Every module specifier `source` imports, statically or dynamically. */
export function importSpecifiers(source) {
  const specifiers = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
  }
  return [...specifiers];
}

/**
 * Resolves an import specifier to a repo-relative path when it points at a file
 * inside the repository, else returns the specifier unchanged (bare package
 * specifiers cannot reach an unexported internal module by construction).
 */
export function resolveSpecifier(repoRoot, fromFile, specifier) {
  if (!specifier.startsWith('.')) return specifier;
  const absolute = path.resolve(path.dirname(fromFile), specifier);
  return path.relative(repoRoot, absolute).split(path.sep).join('/');
}

/**
 * Scans `directories` (repo-relative) and returns every file that imports a
 * writer module, with the offending specifier. Empty means the surface is clean.
 */
export async function findWriterImports(repoRoot, directories) {
  const writerPaths = new Set(WRITER_MODULE_PATHS.map((entry) => `noosphere-mcp/${entry}`));
  const offenders = [];
  for (const directory of directories) {
    const absolute = path.join(repoRoot, directory);
    for (const file of await listSourceFiles(absolute)) {
      const source = await fs.readFile(file, 'utf8');
      for (const specifier of importSpecifiers(source)) {
        const resolved = resolveSpecifier(repoRoot, file, specifier);
        if (writerPaths.has(resolved)) {
          offenders.push({
            file: path.relative(repoRoot, file).split(path.sep).join('/'),
            specifier,
          });
        }
      }
    }
  }
  return offenders.sort((left, right) => left.file.localeCompare(right.file));
}

class BoundaryViolation extends Error {
  constructor(message) {
    super(message);
    this.name = 'BoundaryViolation';
    this.code = 'ERR_WRITER_BOUNDARY';
  }
}

function requireBoundary(condition, message) {
  if (!condition) throw new BoundaryViolation(message);
}

/**
 * The export-map half of the writer boundary, factored out of the test file so
 * the mutation harness can run the IDENTICAL assertions against a mutated copy
 * of the package. Throws BoundaryViolation on the first violation.
 *
 * `packageRoot` must be the root of a noosphere-continuity package tree; module
 * resolution is performed from inside that tree, so a copy with a mutated
 * package.json is checked against its own export map, not this one.
 */
export async function assertExportMapBoundary(packageRoot) {
  const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  const declared = Object.keys(manifest.exports ?? {}).sort();
  requireBoundary(
    declared.length === PUBLIC_EXPORT_PATHS.length &&
      declared.every((entry, index) => entry === PUBLIC_EXPORT_PATHS[index]),
    `export map exposes ${JSON.stringify(declared)}; expected ${JSON.stringify([...PUBLIC_EXPORT_PATHS])}`,
  );

  // Resolve through the package's own export map by self-reference, which is
  // what a package consumer gets.
  const entryUrl = new URL(
    `file://${path.resolve(packageRoot, manifest.exports['./trust-store']).split(path.sep).join('/')}`,
  );
  const publicModule = await import(entryUrl.href);
  const exported = Object.keys(publicModule).sort();
  requireBoundary(
    exported.length === PUBLIC_TRUST_STORE_EXPORTS.length &&
      exported.every((entry, index) => entry === PUBLIC_TRUST_STORE_EXPORTS[index]),
    `public trust-store exports ${JSON.stringify(exported)}; expected ${JSON.stringify([...PUBLIC_TRUST_STORE_EXPORTS])}`,
  );

  for (const writer of ALL_WRITER_NAMES) {
    requireBoundary(
      !(writer in publicModule),
      `public trust-store re-exports the writer ${writer}`,
    );
  }

  // Requirement 9: a mutation primitive reached through an object is still a
  // public mutation primitive.
  for (const [name, value] of Object.entries(publicModule)) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) continue;
    for (const mutator of [...FORMAT_V2_STORE_MUTATORS, ...ALL_WRITER_NAMES]) {
      requireBoundary(
        !(mutator in value),
        `public export ${name} exposes the mutation primitive ${mutator}`,
      );
    }
  }
  return { declared, exported };
}

/**
 * Names the nearest enclosing top-level function declaration for a byte offset.
 * Deliberately simple: every writer call site in the CLI sits inside a
 * `function name(` / `async function name(` declared at column zero.
 */
export function enclosingFunction(source, index) {
  const declarations = [...source.matchAll(/^(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/gm)];
  let enclosing = null;
  for (const declaration of declarations) {
    if (declaration.index > index) break;
    enclosing = declaration[1];
  }
  return enclosing;
}

/**
 * Returns the source text of the top-level function `name`, brace-matched from
 * its opening `{`. Used to scope a scan to one handler instead of a 120 KB CLI.
 */
export function functionBody(source, name) {
  const declaration = new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(`, 'm').exec(source);
  if (!declaration) return null;
  const open = source.indexOf('{', declaration.index);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(declaration.index, index + 1);
    }
  }
  return source.slice(declaration.index);
}

/**
 * Strips line and block comments so a bypass scan cannot be tripped by prose
 * that DOCUMENTS the absence of a bypass — which is exactly what the approval
 * path's comments do.
 */
export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')
    .replace(/([^:'"`\\])\/\/.*$/gm, '$1 ');
}

/** Every `name(` call site of `name` in `source`, with its enclosing function. */
export function callSites(source, name) {
  const pattern = new RegExp(`\\b${name}\\s*\\(`, 'g');
  const sites = [];
  for (const match of source.matchAll(pattern)) {
    // Skip the declaration itself.
    const preceding = source.slice(Math.max(0, match.index - 40), match.index);
    if (/\b(?:function|const|let|var)\s+$/.test(preceding)) continue;
    if (/\bexport\s+(?:async\s+)?function\s+$/.test(preceding)) continue;
    sites.push({
      index: match.index,
      line: source.slice(0, match.index).split('\n').length,
      enclosing: enclosingFunction(source, match.index),
    });
  }
  return sites;
}
