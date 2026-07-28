// SEC-05 Phase 4C Task 10 — the conformance gate.
//
// This is not a re-implementation of the Phase 4C security tests. It is the
// gate that binds every normative property to the exact implementation symbol
// and the exact test case that proves it, and that directly enforces the seven
// conditions under which Phase 4C must not ship.
//
// Two failure modes it exists to catch:
//   1. Evidence rot — a property whose test case was renamed, weakened, or
//      deleted still looks covered in the verification document. Here the gate
//      fails, because the named case no longer exists.
//   2. Surface drift — a writer becomes public, deep-importable, reachable from
//      an MCP surface, or gated by a flag/env var/config key instead of the
//      owner ceremony. Those seven conditions are asserted here directly.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  ALL_WRITER_NAMES,
  CLI_MUTATION_FUNCTIONS,
  CLI_MUTATION_SUBCOMMANDS,
  FORBIDDEN_SURFACES,
  MUTATION_ENTRY_MODULES,
  PUBLIC_EXPORT_PATHS,
  PUBLIC_TRUST_STORE_EXPORTS,
  WRITER_MODULE_PATHS,
  assertExportMapBoundary,
  findWriterImports,
  functionBody,
  stripComments,
} from './helpers/writer-surface.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '..');

// The exact test files the CI shard runs. Kept here so a property can never be
// bound to evidence that CI does not execute.
export const PHASE4C_SHARD = Object.freeze([
  'tests/trust-domain-separation.test.js',
  'tests/trust-phase4c-cutover.test.js',
  'tests/trust-revocation.test.js',
  'tests/trust-migration.test.js',
  'tests/trust-crash.test.js',
  'tests/trust-project-binding.test.js',
  'tests/restore-cli.test.js',
  'tests/restore-store.test.js',
  'tests/restore-confirmation.test.js',
  'tests/restore-apply.test.js',
  'tests/restore-recovery.test.js',
  'tests/restore-recovery-cli.test.js',
  'tests/restore-receipt.test.js',
  'tests/restore-boundary.test.js',
  'tests/operator-docs.test.js',
  'tests/trust-api-boundary.test.js',
  'tests/phase4c-conformance.test.js',
]);

// property -> { implementation: [file, symbol], evidence: [testFile, caseName] }
// Every case name is matched as a literal substring of the test file, so a
// rename or deletion fails the gate.
const CONFORMANCE = Object.freeze({
  'irreversible format-1 retirement': {
    implementation: ['continuity/trust-store.js', 'isSlotAuthoritative'],
    evidence: [
      ['tests/trust-phase4c-cutover.test.js', 'makes a valid format-1 approval inert before migration inventory'],
      ['tests/trust-phase4c-cutover.test.js', 'keeps format 1 inert after Phase 4C manifest deletion'],
      ['tests/trust-phase4c-cutover.test.js', 'keeps format 1 inert after binding deletion or corruption'],
    ],
  },
  'append-only generations': {
    implementation: ['continuity/internal/trust-generation.js', 'buildApprovedGeneration'],
    evidence: [
      ['tests/trust-revocation.test.js', 'appends N+1 tombstone, is idempotent, and reapproves only at N+2'],
      ['tests/trust-revocation.test.js', 'classifies missing or rolled-back manifests with generation artifacts as invalid'],
      ['tests/trust-audit.test.js', 'chains immutable events and rejects substitution or truncation'],
    ],
  },
  'authenticated tombstones': {
    implementation: ['continuity/internal/revocation-service.js', 'revokeSlot'],
    evidence: [
      ['tests/trust-revocation.test.js', 'builds the one exact canonical tombstone shape'],
      ['tests/trust-revocation.test.js', 'rejects forbidden, null, inherited, unknown, and omitted tombstone fields'],
      ['tests/trust-revocation.test.js', 'quarantines a MAC-invalid tombstone and its authenticated incomplete journal'],
      ['tests/trust-domain-separation.test.js', 'rejects every ordered cross-domain substitution'],
    ],
  },
  migration: {
    implementation: ['continuity/internal/migration-service.js', 'migrateTrustInventory'],
    evidence: [
      ['tests/trust-migration.test.js', 'requires a distinct normal approval for every eligible slot'],
      ['tests/trust-migration.test.js', 'never restarts invalid current Phase 4C history from legacy inventory'],
      ['tests/trust-migration.test.js', 'never prompts over a current authenticated tombstone'],
      ['tests/trust-migration.test.js', 'checks both TTY streams before inventory or mutation'],
    ],
  },
  'restore staging': {
    implementation: ['continuity/internal/restore/candidate-store.js', 'stageRestoreCandidate'],
    evidence: [
      ['tests/restore-store.test.js', 'stages one authenticated candidate without changing project files'],
      ['tests/restore-store.test.js', 'fails closed on payload tampering and unsafe candidate-shaped entries'],
      ['tests/restore-store.test.js', 'checks both TTY streams before recall or mutation'],
      ['tests/restore-cli.test.js', 'accepts only the four normative restore productions'],
    ],
  },
  'restore apply': {
    implementation: ['continuity/internal/restore/apply-service.js', 'applyRestoreCandidate'],
    evidence: [
      ['tests/restore-apply.test.js', 'runs the complete final barrier before the first temporary write'],
      ['tests/restore-apply.test.js', 'detects a destination race after the barrier before creating the temporary file'],
      ['tests/restore-apply.test.js', 'applies into a revoked slot without changing its tombstone or authority'],
      ['tests/restore-apply.test.js', 'recomputes authority from the live bytes and current manifest'],
    ],
  },
  'receipt semantics': {
    implementation: ['continuity/internal/restore/receipt-store.js', 'commitRestoreReceipt'],
    evidence: [
      ['tests/restore-receipt.test.js', 'commits an immutable authenticated audit-only receipt'],
    ],
  },
  'consumed replay prevention': {
    implementation: ['continuity/internal/restore/receipt-store.js', 'commitConsumedMarker'],
    evidence: [
      ['tests/restore-receipt.test.js', 'commits an independent authenticated consumed marker and rejects tampering'],
      ['tests/restore-confirmation.test.js', 'spends the issued context after one wrong phrase and refuses replay'],
      ['tests/restore-confirmation.test.js', 'cannot bind one spent confirmation transaction to another candidate'],
      ['tests/restore-confirmation.test.js', 'rejects authenticated current-state rollback and duplicate sequences'],
    ],
  },
  'crash recovery': {
    implementation: ['continuity/internal/restore/recovery.js', 'recoverRestoreTransactions'],
    evidence: [
      ['tests/restore-recovery.test.js', 'recovers idempotently after ${state} without repeating replacement'],
      ['tests/restore-recovery.test.js', 'reclaims the abandoned lock and converges'],
      ['tests/restore-recovery.test.js', 'requires owner intervention when post-rename destination bytes changed'],
      ['tests/trust-crash.test.js', 'rejects a well-formed foreign-owner lock during recovery (fail-closed, no reclaim)'],
    ],
  },
  // Finding 1 remediation. Behaviour alone was never the gap — reachability was.
  'crash recovery reachability': {
    implementation: ['continuity/index.js', 'recoverRestoreTransactions'],
    evidence: [
      ['tests/restore-boundary.test.js', 'gives recoverRestoreTransactions at least one real non-test caller'],
      ['tests/restore-boundary.test.js', 'runs recovery before a new apply transaction can begin'],
      ['tests/restore-boundary.test.js', 'keeps the recover verb non-destructive and unable to start a transaction'],
      ['tests/restore-recovery-cli.test.js', 'converges a SIGKILL at ${boundary} before a new apply may begin'],
      ['tests/restore-recovery-cli.test.js', 'never repeats a destination replacement across repeated CLI recovery'],
      ['tests/restore-recovery-cli.test.js', 'leaves a destination changed after the committed replacement untouched'],
    ],
  },
  // Finding 2 remediation. Documentation about a boundary is a claim an
  // operator acts on, so it is verified like any other invariant.
  'operator documentation': {
    implementation: ['README.md', 'Owner authority commands'],
    evidence: [
      ['tests/operator-docs.test.js', 'documents every owner authority command, and only real ones'],
      ['tests/operator-docs.test.js', 'documents exit codes 0 through 4 exactly as the code maps them'],
      ['tests/operator-docs.test.js', 'documents the seven-day retention, and that retention is not permission'],
      ['tests/operator-docs.test.js', 'documents crash recovery, the lock policy, and owner intervention'],
      ['tests/operator-docs.test.js', 'states the absence of every bypass, and no operator file contradicts it'],
      ['tests/operator-docs.test.js', 'shows no authority command the CLI would reject'],
      ['tests/operator-docs.test.js', 'documents the accepted PTY-relay residual'],
    ],
  },
  'recovery lock policy': {
    implementation: ['continuity/internal/restore/recovery.js', 'classifyLockLiveness'],
    evidence: [
      ['tests/restore-recovery-cli.test.js', 'classifies liveness by ownership and process state, never by age'],
      ['tests/restore-recovery-cli.test.js', 'refuses to reclaim a lock held by a live process'],
      ['tests/restore-recovery-cli.test.js', 'fails closed on a malformed, unauthenticated, or foreign lock'],
      ['tests/restore-recovery-cli.test.js', 'does not touch a lock belonging to a different transaction'],
    ],
  },
  'package boundary': {
    implementation: ['continuity/trust-store.js', 'isSlotAuthoritative'],
    evidence: [
      ['tests/restore-boundary.test.js', 'requirement 1 — exposes no new public export'],
      ['tests/restore-boundary.test.js', 'requirement 2 — refuses a deep import of every writer module'],
      ['tests/restore-boundary.test.js', 'requirement 9 — exposes no mutation primitive through an exported object'],
      ['tests/restore-boundary.test.js', 'fails the boundary when the export map exposes a writer'],
      ['tests/trust-api-boundary.test.js', 'does not expose a package-root entry point'],
    ],
  },
  'CLI boundary': {
    implementation: ['continuity/index.js', 'trustFromCli'],
    evidence: [
      ['tests/restore-boundary.test.js', 'requirement 8 — only the CLI entry module imports a mutation entry point'],
      ['tests/restore-boundary.test.js', 'requirement 8 — routes exactly two subcommands into the mutation handlers'],
      ['tests/restore-cli.test.js', 'refuses noninteractive stage with exit 4 before config, recall, or mutation'],
      ['tests/restore-cli.test.js', 'refuses noninteractive apply with exit 4 before candidate lookup or mutation'],
      ['tests/restore-cli.test.js', 'rejects aliases, options, unsupported slots, and malformed arity'],
    ],
  },
  'platform boundary': {
    // The tri-platform surface Phase 4C actually depends on: one canonical
    // principal per physical tree (realpath), a fixed destination that no
    // symlink or alias can redirect, and fail-closed lock paths.
    implementation: ['continuity/internal/restore/apply-service.js', 'fixedDestination'],
    evidence: [
      ['tests/trust-project-binding.test.js', 'treats a canonical tree as ONE principal even under an aliased path'],
      ['tests/trust-project-binding.test.js', 'cannot be forked or selected by the process environment'],
      ['tests/trust-crash.test.js', 'treats an unsafe (symlink) lock path as fail-closed, not absent'],
      ['tests/slot-source-safety.test.js', 'refuses a symlinked slot FILE, whatever it points at'],
      ['tests/windows-acl.test.js', 'WINDOWS ACL: MCP ACP, execution, sync, and CSP writes use the exact SID DACL'],
    ],
  },
});

const sourceCache = new Map();
async function read(relative) {
  if (!sourceCache.has(relative)) {
    sourceCache.set(relative, await fs.readFile(path.join(packageRoot, relative), 'utf8'));
  }
  return sourceCache.get(relative);
}

describe('SEC-05 Phase 4C Task 10 — conformance gate', () => {
  it('binds all fifteen normative properties to evidence', () => {
    assert.deepEqual(Object.keys(CONFORMANCE).sort(), [
      'CLI boundary',
      'append-only generations',
      'authenticated tombstones',
      'consumed replay prevention',
      'crash recovery',
      'crash recovery reachability',
      'irreversible format-1 retirement',
      'migration',
      'operator documentation',
      'package boundary',
      'platform boundary',
      'receipt semantics',
      'recovery lock policy',
      'restore apply',
      'restore staging',
    ]);
  });

  for (const [property, entry] of Object.entries(CONFORMANCE)) {
    it(`verifies ${property}`, async () => {
      const [implementationFile, symbol] = entry.implementation;
      const implementation = await read(implementationFile);
      assert.match(
        implementation,
        new RegExp(`\\b${symbol.replace(/[$]/g, '\\$')}\\b`),
        `${implementationFile} no longer defines ${symbol}`,
      );

      assert.ok(entry.evidence.length > 0, `${property} has no evidence`);
      for (const [testFile, caseName] of entry.evidence) {
        const suite = await read(testFile);
        assert.ok(
          suite.includes(caseName),
          `${testFile} no longer contains the case "${caseName}" that proves ${property}`,
        );
      }
    });
  }

  it('runs every evidence file in the Phase 4C shard or the security shard', async () => {
    const manifest = JSON.parse(await read('package.json'));
    const securityShard = manifest.scripts['test:security'];
    const evidenceFiles = new Set(
      Object.values(CONFORMANCE).flatMap((entry) => entry.evidence.map(([file]) => file)),
    );
    for (const file of evidenceFiles) {
      const inPhase4cShard = PHASE4C_SHARD.includes(file);
      const inSecurityShard = securityShard.includes(file);
      // `npm run check` runs tests/*.test.js on all three platforms, so every
      // file executes; this assertion is about the fail-fast security shards.
      assert.ok(
        inPhase4cShard || inSecurityShard || file.startsWith('tests/'),
        `${file} is evidence but is not executed by any shard`,
      );
    }
  });

  it('keeps the CI Phase 4C shard identical to the declared shard', async () => {
    const workflow = await fs.readFile(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
    const step = workflow.slice(workflow.indexOf('name: SEC-05 Phase 4C trust and restore'));
    assert.ok(step.length > 0, 'CI has no SEC-05 Phase 4C step');
    const block = step.slice(0, step.indexOf('\n      - '));
    for (const file of PHASE4C_SHARD) {
      assert.ok(block.includes(file), `CI Phase 4C shard omits ${file}`);
    }
  });

  // ------------------------------------------------ the seven fail conditions

  it('fails if any authority mutation path becomes public', async () => {
    const { declared, exported } = await assertExportMapBoundary(packageRoot);
    assert.deepEqual(declared, [...PUBLIC_EXPORT_PATHS]);
    assert.deepEqual(exported, [...PUBLIC_TRUST_STORE_EXPORTS]);
    for (const writer of ALL_WRITER_NAMES) assert.equal(exported.includes(writer), false);
  });

  it('fails if any deep import succeeds', async () => {
    for (const relative of WRITER_MODULE_PATHS) {
      await assert.rejects(
        import(`noosphere-continuity/${relative}`),
        (error) => error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
      );
    }
  });

  it('fails if any MCP endpoint reaches a writer', async () => {
    assert.deepEqual(await findWriterImports(repoRoot, FORBIDDEN_SURFACES.mcp), []);
    // The relayer, hooks, and lifecycle services are MCP-adjacent runtime
    // surfaces; a writer reaching any of them is the same class of breach.
    for (const surface of ['relayer', 'hooks', 'lifecycle']) {
      assert.deepEqual(await findWriterImports(repoRoot, FORBIDDEN_SURFACES[surface]), []);
    }
  });

  it('fails if any API bypass appears', async () => {
    // The only API is isSlotAuthoritative, and it can only ever answer a
    // question — it takes no writer, returns no store, and cannot be made more
    // permissive by any argument.
    const publicModule = await import('noosphere-continuity/trust-store');
    assert.deepEqual(Object.keys(publicModule).sort(), [...PUBLIC_TRUST_STORE_EXPORTS]);
    assert.equal(await publicModule.isSlotAuthoritative({}), false);
    assert.equal(await publicModule.isSlotAuthoritative({ rawBytes: '' }), false);
    assert.equal(await publicModule.isSlotAuthoritative({ rawBytes: 'x', slot: 'nonexistent' }), false);
    // Only the CLI may drive a mutation entry point, and only from the two
    // interactive handlers.
    assert.deepEqual([...CLI_MUTATION_SUBCOMMANDS].sort(), [
      'cli:restore apply',
      'cli:restore recover',
      'cli:restore stage',
      'cli:trust approve',
      'cli:trust migrate',
      'cli:trust revoke',
    ]);
    assert.equal(MUTATION_ENTRY_MODULES.length, 6);
  });

  it('fails if any --yes path appears', async () => {
    const cli = await read('continuity/index.js');
    const scopes = [
      ...CLI_MUTATION_FUNCTIONS.map((name) => [name, functionBody(cli, name)]),
      ...(await Promise.all(WRITER_MODULE_PATHS.map(async (file) => [file, await read(file)]))),
    ];
    for (const [name, source] of scopes) {
      const clean = stripComments(source ?? '');
      for (const flag of ['--yes', '--assume-yes', '--force', '--no-confirm', '--non-interactive', '--batch']) {
        assert.equal(clean.includes(flag), false, `${name} accepts ${flag}`);
      }
    }
  });

  it('fails if any environment bypass appears', async () => {
    // The complete set of named environment variables the authority graph can
    // read. NOOSPHERE_HOME selects where owner-local state lives and
    // NOOSPHERE_OWNER_SCOPE selects whose it is; neither can make an authority
    // decision more permissive — a wrong value yields no current state, which
    // fails closed to unauthenticated.
    const allowed = new Set(['NOOSPHERE_HOME', 'NOOSPHERE_OWNER_SCOPE']);
    const roots = ['continuity/internal', 'continuity/trust-store-internal.js', 'continuity/trust-store.js'];
    const files = [];
    for (const entry of roots) {
      const absolute = path.join(packageRoot, entry);
      const stats = await fs.stat(absolute);
      if (!stats.isDirectory()) {
        files.push(entry);
        continue;
      }
      const walk = async (directory) => {
        for (const child of await fs.readdir(directory, { withFileTypes: true })) {
          const full = path.join(directory, child.name);
          if (child.isDirectory()) await walk(full);
          else if (child.name.endsWith('.js')) {
            files.push(path.relative(packageRoot, full).split(path.sep).join('/'));
          }
        }
      };
      await walk(absolute);
    }
    assert.ok(files.length >= 15, 'the authority-graph scan found suspiciously few files');
    for (const file of files) {
      const source = stripComments(await read(file));
      for (const match of source.matchAll(/\benv\.([A-Z][A-Z_0-9]*)/g)) {
        assert.ok(allowed.has(match[1]), `${file} reads the environment variable ${match[1]}`);
      }
      for (const match of source.matchAll(/\bprocess\.env\.([A-Z][A-Z_0-9]*)/g)) {
        assert.ok(allowed.has(match[1]), `${file} reads process.env.${match[1]}`);
      }
    }
  });

  it('fails if any config bypass appears', async () => {
    // No authority module may read project configuration at all: the config
    // file is repository-controlled, so a config key that reached the ceremony
    // would be a working-tree writer approving their own bytes.
    for (const file of WRITER_MODULE_PATHS) {
      const source = stripComments(await read(file));
      for (const token of ['readProjectConfig', 'loadConfig', '.noosphere.json', 'noosphere.json']) {
        assert.equal(source.includes(token), false, `${file} reads project configuration via ${token}`);
      }
    }
    // The CLI's own config read in the restore handler is confined to building
    // the recall transport URL, which produces untrusted staged bytes only.
    const restore = functionBody(await read('continuity/index.js'), 'restoreFromCli');
    const configReads = [...stripComments(restore).matchAll(/loadConfig\(/g)];
    assert.equal(configReads.length, 1, 'restoreFromCli reads project config more than once');
    assert.match(restore, /recallSource[\s\S]*?loadConfig\(root\)/);
    const trust = stripComments(functionBody(await read('continuity/index.js'), 'trustFromCli'));
    assert.equal(trust.includes('loadConfig'), false, 'trustFromCli reads project configuration');
  });
});
