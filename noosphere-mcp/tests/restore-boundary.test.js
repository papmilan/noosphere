// SEC-05 Phase 4C Task 9 — authority-writer surface audit.
//
// Every mutation primitive minted by Phase 4C (approval, revocation, migration,
// restore staging and apply, receipts, consumed markers, crash recovery, and the
// apply journal) must remain internal. This suite is the executable form of that
// claim: it walks the real export map, the real module graph of every production
// surface, and the real CLI dispatch, and it proves — by mutation — that the
// assertions actually fail when a writer becomes reachable.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import { npmCommand, npmSpawnOptions } from '../lifecycle/util.js';
import {
  ALL_WRITER_NAMES,
  CLI_ENTRY_MODULE,
  CLI_MUTATION_FUNCTIONS,
  FORBIDDEN_SURFACES,
  FORMAT_V2_STORE_MUTATORS,
  MUTATION_ENTRY_MODULES,
  PRIMITIVE_IMPORT_ALLOWLIST,
  PRIMITIVE_MODULES,
  PUBLIC_EXPORT_PATHS,
  PUBLIC_TRUST_STORE_EXPORTS,
  READ_ONLY_EXPORTS,
  WRITER_MODULES,
  WRITER_MODULE_PATHS,
  assertExportMapBoundary,
  callSites,
  findWriterImports,
  functionBody,
  importSpecifiers,
  listSourceFiles,
  resolveSpecifier,
  stripComments,
} from './helpers/writer-surface.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '..');
const childScript = path.join(packageRoot, 'tests', 'helpers', 'export-map-child.mjs');
const temporary = [];

after(async () => {
  await Promise.all(temporary.map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

async function readPackageFile(relative) {
  return fs.readFile(path.join(packageRoot, relative), 'utf8');
}

describe('SEC-05 Phase 4C Task 9 — authority-writer surface audit', () => {
  // ---------------------------------------------------------------- inventory

  it('classifies every export of every writer module', async () => {
    for (const relative of WRITER_MODULE_PATHS) {
      // pathToFileURL, not the raw path: on Windows an absolute path is not a
      // valid ESM specifier ('d:' is read as a URL scheme).
      const module = await import(pathToFileURL(path.join(packageRoot, relative)).href);
      const declared = [
        ...Object.values(WRITER_MODULES)
          .filter((entry) => entry.module === relative)
          .flatMap((entry) => entry.writers),
        ...READ_ONLY_EXPORTS[relative],
      ].sort();
      assert.deepEqual(
        Object.keys(module).sort(),
        [...new Set(declared)],
        `${relative} has an export the Phase 4C writer inventory does not classify`,
      );
    }
  });

  it('covers all eight required writer categories', () => {
    // The audit categories the specification names, mapped onto the inventory.
    // commitConsumedMarker shares receipt-store.js with commitRestoreReceipt.
    const byCategory = {
      approval: WRITER_MODULES.approval.writers,
      revocation: WRITER_MODULES.revocation.writers,
      migration: WRITER_MODULES.migration.writers,
      'restore apply': [
        ...WRITER_MODULES.restoreApply.writers,
        ...WRITER_MODULES.restoreStaging.writers,
      ],
      receipt: ['commitRestoreReceipt'],
      'consumed marker': ['commitConsumedMarker'],
      recovery: WRITER_MODULES.recovery.writers,
      journal: WRITER_MODULES.journal.writers,
    };
    for (const [category, writers] of Object.entries(byCategory)) {
      assert.ok(writers.length > 0, `${category} has no writer in the inventory`);
      for (const writer of writers) {
        assert.ok(ALL_WRITER_NAMES.includes(writer), `${writer} (${category}) is unclassified`);
      }
    }
  });

  // ------------------------------------------- requirement 1: no new exports

  it('requirement 1 — exposes no new public export', async () => {
    const { declared, exported } = await assertExportMapBoundary(packageRoot);
    assert.deepEqual(declared, [...PUBLIC_EXPORT_PATHS]);
    assert.deepEqual(exported, [...PUBLIC_TRUST_STORE_EXPORTS]);
  });

  it('requirement 1 — ships the same export map inside the packed tarball', async () => {
    // Reuse the package's npm shim: on Windows npm is npm.cmd and Node refuses
    // to spawn .cmd without shell:true (CVE-2024-27980 mitigation).
    const packed = JSON.parse(execFileSync(
      npmCommand(),
      ['pack', '--dry-run', '--json', '--cache', path.join(os.tmpdir(), 'noosphere-npm-cache')],
      { cwd: packageRoot, encoding: 'utf8', ...npmSpawnOptions() },
    ));
    const names = packed[0].files.map((entry) => entry.path);
    assert.equal(names.includes('package.json'), true);
    assert.equal(names.some((name) => name.startsWith('tests/')), false);
    // The writer modules ship (the CLI needs them) but remain unexported; that
    // is precisely why the export map, not the file list, is the boundary.
    for (const relative of WRITER_MODULE_PATHS) {
      assert.equal(names.includes(relative), true, `${relative} must ship for the CLI`);
    }
  });

  // ------------------------------------------ requirement 2: no deep imports

  it('requirement 2 — refuses a deep import of every writer module', async () => {
    const require = createRequire(path.join(packageRoot, 'noop.cjs'));
    for (const relative of WRITER_MODULE_PATHS) {
      const specifier = `noosphere-continuity/${relative}`;
      await assert.rejects(
        import(specifier),
        (error) => error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
        `${specifier} resolved through the export map`,
      );
      assert.throws(
        () => require.resolve(specifier),
        (error) => error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
        `${specifier} resolved through CommonJS`,
      );
    }
  });

  it('requirement 2 — refuses a deep import of the restore directory itself', async () => {
    for (const specifier of [
      'noosphere-continuity/continuity/internal/restore/',
      'noosphere-continuity/continuity/internal/',
      'noosphere-continuity/continuity/index.js',
    ]) {
      await assert.rejects(
        import(specifier),
        (error) => error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
      );
    }
  });

  // -------------------------------- requirements 3-7: consumer surface scans

  for (const [surface, directories] of Object.entries(FORBIDDEN_SURFACES)) {
    it(`requirement — no ${surface} surface imports a writer`, async () => {
      assert.deepEqual(await findWriterImports(repoRoot, directories), []);
    });
  }

  it('requirement 6 — the generated adapters name no internal module path', async () => {
    // Adapters are text the CLI writes into a consumer's repository. They must
    // instruct the agent to run a command, never to import or execute a module.
    const cli = await readPackageFile(CLI_ENTRY_MODULE);
    for (const generator of ['writeAgentAdapters', 'writeMcpConfigs']) {
      const managed = functionBody(cli, generator);
      assert.ok(managed, `${generator} is no longer the adapter generator`);
      for (const relative of WRITER_MODULE_PATHS) {
        assert.equal(managed.includes(relative), false, `${generator} names ${relative}`);
        assert.equal(managed.includes(path.basename(relative)), false, `${generator} names ${relative}`);
      }
      for (const writer of ALL_WRITER_NAMES) {
        assert.equal(managed.includes(writer), false, `${generator} names ${writer}`);
      }
    }
    for (const file of await listSourceFiles(path.join(packageRoot, 'mcp-server'))) {
      const source = await fs.readFile(file, 'utf8');
      for (const writer of ALL_WRITER_NAMES) assert.equal(source.includes(writer), false);
      for (const relative of WRITER_MODULE_PATHS) assert.equal(source.includes(relative), false);
    }
  });

  // ------------------------------------- requirement 8: CLI reachability only

  async function importersOf(modules) {
    const targets = new Set(modules.map((entry) => `noosphere-mcp/${entry}`));
    const importers = new Set();
    for (const directory of ['noosphere-mcp/continuity', 'noosphere-mcp/lifecycle', 'noosphere-mcp/hooks']) {
      for (const file of await listSourceFiles(path.join(repoRoot, directory))) {
        const relative = path.relative(packageRoot, file).split(path.sep).join('/');
        // A writer reaching another writer is the internal authority graph, not
        // a consumer surface; only non-writer modules can breach the boundary.
        if (WRITER_MODULE_PATHS.includes(relative)) continue;
        const source = await fs.readFile(file, 'utf8');
        for (const specifier of importSpecifiers(source)) {
          if (targets.has(resolveSpecifier(repoRoot, file, specifier))) importers.add(relative);
        }
      }
    }
    return [...importers].sort();
  }

  it('requirement 8 — only the CLI entry module imports a mutation entry point', async () => {
    assert.deepEqual(await importersOf([...MUTATION_ENTRY_MODULES]), [CLI_ENTRY_MODULE]);
  });

  it('requirement 8 — confines the mutation primitives to the internal graph', async () => {
    // The primitives (journal, receipt, consumed marker, recovery, confirmation,
    // state machine, format-2 store, trust-store-internal) carry read-only
    // exports too, so they may be imported inside continuity/internal/** and by
    // the public authority gate — never from a service, hook, or adapter.
    const importers = await importersOf([...PRIMITIVE_MODULES]);
    const outside = importers.filter((entry) =>
      !entry.startsWith('continuity/internal/') && !PRIMITIVE_IMPORT_ALLOWLIST.includes(entry));
    assert.deepEqual(outside, []);
  });

  it('requirement 8 — calls every mutation entry point only from the interactive commands', async () => {
    const cli = await readPackageFile(CLI_ENTRY_MODULE);
    const entryPoints = [
      'approveSlot',
      'revokeSlot',
      'migrateTrustInventory',
      'stageRestoreCandidate',
      'applyRestoreCandidate',
    ];
    for (const name of entryPoints) {
      const sites = callSites(cli, name);
      assert.ok(sites.length > 0, `${name} is imported but never called`);
      for (const site of sites) {
        assert.ok(
          CLI_MUTATION_FUNCTIONS.includes(site.enclosing),
          `${name} is called from ${site.enclosing} at ${CLI_ENTRY_MODULE}:${site.line}`,
        );
      }
    }
  });

  // ------------------- Finding 1 remediation: recovery is production-reachable

  it('gives recoverRestoreTransactions at least one real non-test caller', async () => {
    const importers = await importersOf(['continuity/internal/restore/recovery.js']);
    assert.deepEqual(importers, [CLI_ENTRY_MODULE]);
    const cli = await readPackageFile(CLI_ENTRY_MODULE);
    const sites = callSites(cli, 'recoverRestoreTransactions');
    assert.equal(sites.length, 2, 'expected exactly the apply pre-pass and the recover verb');
    for (const site of sites) assert.equal(site.enclosing, 'restoreFromCli');
  });

  // MUTATION TARGET: "remove the production recovery call" and "move recovery
  // after new transaction creation" both die here. The apply verb must call
  // recovery strictly before applyRestoreCandidate, in source order, inside the
  // same handler — an apply that starts a transaction first has already
  // stacked a second journal on an unresolved one.
  it('runs recovery before a new apply transaction can begin', async () => {
    const handler = functionBody(await readPackageFile(CLI_ENTRY_MODULE), 'restoreFromCli');
    const recoverIndex = handler.lastIndexOf('recoverRestoreTransactions(');
    const applyIndex = handler.indexOf('applyRestoreCandidate(');
    assert.notEqual(recoverIndex, -1, 'restoreFromCli no longer calls recovery');
    assert.notEqual(applyIndex, -1, 'restoreFromCli no longer calls apply');
    assert.ok(
      recoverIndex < applyIndex,
      'recovery must run before applyRestoreCandidate, not after',
    );
    // Nothing may sit between them that could create state: the pre-pass is the
    // immediately preceding statement.
    const between = handler.slice(
      handler.indexOf(';', recoverIndex) + 1,
      handler.lastIndexOf('\n', applyIndex),
    );
    assert.equal(
      /\b(await|=)\b/.test(between.replace(/\/\/.*$/gm, '')),
      false,
      `an operation was inserted between recovery and apply: ${between.trim()}`,
    );
  });

  it('keeps the recover verb non-destructive and unable to start a transaction', async () => {
    const handler = functionBody(await readPackageFile(CLI_ENTRY_MODULE), 'restoreFromCli');
    const branch = handler.slice(
      handler.indexOf("if (parsed.verb === 'recover')"),
      handler.indexOf("if (parsed.verb === 'list')"),
    );
    assert.ok(branch.includes('recoverRestoreTransactions('), 'the recover verb does not recover');
    for (const forbidden of [
      'stageRestoreCandidate',
      'applyRestoreCandidate',
      'approveSlot',
      'revokeSlot',
      'migrateTrustInventory',
    ]) {
      assert.equal(branch.includes(forbidden), false, `restore recover can call ${forbidden}`);
    }
    // It takes no argument, so it cannot select or target a transaction.
    const { parseRestoreArgs } = await import('../continuity/internal/restore/cli.js');
    assert.deepEqual({ ...parseRestoreArgs(['recover']) }, { verb: 'recover' });
    for (const args of [['recover', 'baseline'], ['recover', 'x'], ['recover', '--all']]) {
      assert.throws(() => parseRestoreArgs(args), (error) => error?.code === 'ERR_CLI_USAGE');
    }
  });

  it('requirement 8 — routes exactly two subcommands into the mutation handlers', async () => {
    const cli = await readPackageFile(CLI_ENTRY_MODULE);
    const dispatch = [...cli.matchAll(/case '([a-z-]+)':\s*\n\s*await (\w+)\(/g)]
      .filter(([, , handler]) => CLI_MUTATION_FUNCTIONS.includes(handler))
      .map(([, subcommand, handler]) => `${subcommand} -> ${handler}`)
      .sort();
    assert.deepEqual(dispatch, ['restore -> restoreFromCli', 'trust -> trustFromCli']);
  });

  it('requirement 8 — offers no --yes, environment, or config bypass', async () => {
    const cli = await readPackageFile(CLI_ENTRY_MODULE);
    const sources = [
      // Scoped to the two mutation handlers: the rest of a 120 KB CLI carries
      // unrelated flags (`noosphere baseline --force`) that are not authority
      // bypasses, and scanning it whole would make the assertion meaningless.
      ...CLI_MUTATION_FUNCTIONS.map((name) => [`${CLI_ENTRY_MODULE}#${name}`, functionBody(cli, name)]),
      ...(await Promise.all(WRITER_MODULE_PATHS.map(async (relative) =>
        [relative, await readPackageFile(relative)]))),
      ['continuity/internal/exact-confirmation.js', await readPackageFile('continuity/internal/exact-confirmation.js')],
    ].map(([name, source]) => [name, stripComments(source ?? '')]);
    // A flag, an environment variable, or a config key that skips the owner
    // ceremony is the whole attack. None may exist in any writer path.
    const bypasses = [
      /--yes\b/, /--force\b/, /--non-interactive\b/, /--assume-yes\b/, /--no-confirm\b/,
      /NOOSPHERE_[A-Z_]*(?:APPROVE|TRUST|RESTORE|CONFIRM|YES|FORCE|SKIP|BYPASS)[A-Z_]*/,
      /\bskipConfirm(?:ation)?\b/, /\bautoApprove\b/, /\bforceApprove\b/,
    ];
    for (const [name, source] of sources) {
      for (const pattern of bypasses) {
        const match = source.match(pattern);
        assert.equal(match, null, `${name} contains a bypass affordance: ${match?.[0]}`);
      }
    }
  });

  // ------------------------- requirement 9: no object re-export of a primitive

  it('requirement 9 — re-exports no writer module through a barrel', async () => {
    for (const directory of ['continuity', 'continuity/internal', 'continuity/internal/restore', 'continuity/acp', 'continuity/csp', 'lifecycle', 'hooks']) {
      for (const file of await listSourceFiles(path.join(packageRoot, directory))) {
        const relative = path.relative(packageRoot, file).split(path.sep).join('/');
        if (WRITER_MODULE_PATHS.includes(relative)) continue;
        const source = await fs.readFile(file, 'utf8');
        for (const match of source.matchAll(/export\s+(\*|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/g)) {
          const [, clause, specifier] = match;
          const resolved = resolveSpecifier(repoRoot, file, specifier);
          if (!WRITER_MODULE_PATHS.some((writer) => resolved === `noosphere-mcp/${writer}`)) continue;
          // A star re-export of a writer module republishes every writer in it.
          assert.notEqual(clause, '*', `${relative} star-re-exports the writer module ${specifier}`);
          const names = clause.slice(1, -1).split(',')
            .map((entry) => entry.split(/\s+as\s+/)[0].trim())
            .filter(Boolean);
          for (const name of names) {
            assert.equal(
              ALL_WRITER_NAMES.includes(name),
              false,
              `${relative} re-exports the writer ${name} from ${specifier}`,
            );
          }
        }
      }
    }
  });

  it('requirement 9 — exposes no mutation primitive through an exported object', async () => {
    const publicModule = await import('noosphere-continuity/trust-store');
    for (const [name, value] of Object.entries(publicModule)) {
      if (!value || (typeof value !== 'object' && typeof value !== 'function')) continue;
      for (const mutator of [...FORMAT_V2_STORE_MUTATORS, ...ALL_WRITER_NAMES]) {
        assert.equal(mutator in value, false, `${name} exposes ${mutator}`);
      }
    }
    // The store facade IS an object full of mutation primitives — that is the
    // shape requirement 9 guards against — so prove it is only ever produced
    // behind the internal factory, never handed out.
    const { createFormatV2Store } = await import('../continuity/internal/trust-format-v2.js');
    const facade = createFormatV2Store({ env: { NOOSPHERE_HOME: os.tmpdir() } });
    for (const mutator of FORMAT_V2_STORE_MUTATORS) {
      assert.equal(typeof facade[mutator], 'function', `${mutator} is no longer a store method`);
    }
    assert.equal('createFormatV2Store' in publicModule, false);
  });

  // ------------------------------------------------------ mutation of the map

  it('fails the boundary when the export map exposes a writer', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-4c-mutation-'));
    temporary.push(workspace);
    const mutant = path.join(workspace, 'noosphere-mcp');
    await fs.cp(path.join(packageRoot, 'continuity'), path.join(mutant, 'continuity'), { recursive: true });
    await fs.cp(path.join(packageRoot, 'package.json'), path.join(mutant, 'package.json'));
    // Bare dependency specifiers (@noosphere/secure-fs) must still resolve.
    await fs.symlink(path.join(packageRoot, 'node_modules'), path.join(mutant, 'node_modules'), 'junction')
      .catch(() => fs.cp(path.join(packageRoot, 'node_modules'), path.join(mutant, 'node_modules'), { recursive: true }));

    const run = () => spawnSync(process.execPath, [childScript, mutant], { encoding: 'utf8' });

    // Control: the unmutated copy passes, so a failure below is the mutation
    // and not a broken harness.
    const control = run();
    assert.equal(control.status, 0, `control run failed: ${control.stderr}`);

    const manifestPath = path.join(mutant, 'package.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));

    // Mutation A: publish a writer module through a new export path.
    manifest.exports['./restore-apply'] = './continuity/internal/restore/apply-service.js';
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    const mutantA = run();
    assert.equal(mutantA.status, 7, `export-path mutation was not caught: ${mutantA.stderr}`);
    assert.match(mutantA.stderr, /export map exposes .*restore-apply/);

    // Mutation B: keep the export map intact but re-export one writer from the
    // single supported entry point.
    delete manifest.exports['./restore-apply'];
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    const entry = path.join(mutant, 'continuity', 'trust-store.js');
    await fs.appendFile(
      entry,
      "\nexport { approveSlot } from './internal/approval-service.js';\n",
    );
    const mutantB = run();
    assert.equal(mutantB.status, 7, `re-export mutation was not caught: ${mutantB.stderr}`);
    assert.match(mutantB.stderr, /approveSlot/);
  });
});
