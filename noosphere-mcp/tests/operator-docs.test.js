// SEC-05 Phase 4C, Finding 2 remediation — operator documentation conformance.
//
// Documentation about a security boundary is a claim, and a claim that drifts
// from the code is worse than no claim: an operator who believes there is no
// `--yes` flag, or that a candidate is one-shot, or that a destination is fixed,
// will act on it. So every normative statement is checked against the code that
// implements it, and every operator-facing file is scanned for statements that
// contradict the product.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { RESTORE_SLOTS, ACTIVE_RETENTION_MS } from '../continuity/internal/restore/constants.js';
import { APPROVABLE_SLOTS } from '../continuity/slot-sources.js';
import { parseRestoreArgs } from '../continuity/internal/restore/cli.js';
import { functionBody } from './helpers/writer-surface.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '..');

// Every operator-facing file that carries an authority or restore claim. A new
// one must be added here, or its claims are unchecked.
const OPERATOR_DOCS = Object.freeze([
  'noosphere-mcp/README.md',
  'README.md',
  'SECURITY.md',
]);

// The single authoritative operator reference.
const REFERENCE = 'noosphere-mcp/README.md';

const cache = new Map();
async function doc(relative) {
  if (!cache.has(relative)) {
    cache.set(relative, await fs.readFile(path.join(repoRoot, relative), 'utf8'));
  }
  return cache.get(relative);
}

describe('SEC-05 Phase 4C — operator documentation', () => {
  it('documents every owner authority command, and only real ones', async () => {
    const reference = await doc(REFERENCE);
    const required = [
      'noosphere trust migrate',
      'noosphere trust approve',
      'noosphere trust revoke',
      'noosphere restore stage',
      'noosphere restore list',
      'noosphere restore show',
      'noosphere restore apply',
      'noosphere restore recover',
    ];
    for (const command of required) {
      assert.ok(reference.includes(command), `${REFERENCE} does not document \`${command}\``);
    }

    // Every documented restore verb must actually parse, and every verb the
    // parser accepts must be documented. Neither direction may drift.
    const documentedVerbs = required
      .filter((command) => command.startsWith('noosphere restore '))
      .map((command) => command.split(' ')[2]);
    for (const verb of documentedVerbs) {
      const args = verb === 'stage' ? [verb, 'baseline']
        : verb === 'show' || verb === 'apply' ? [verb, 'a'.repeat(51) + 'a']
          : [verb];
      // `stage`, `list`, and `recover` parse outright; `show`/`apply` need a
      // canonical ID, so only assert the verb is not rejected as unknown.
      try {
        assert.equal(parseRestoreArgs(args).verb, verb);
      } catch (error) {
        assert.equal(error.code, 'ERR_CLI_USAGE');
        assert.match(error.message, /candidate ID/, `restore ${verb} is documented but unknown`);
      }
    }
    for (const unknown of ['restore-all', 'purge', 'reset', 'force']) {
      assert.equal(
        reference.includes(`noosphere restore ${unknown}`),
        false,
        `${REFERENCE} documents a restore verb that does not exist: ${unknown}`,
      );
    }
  });

  it('documents the exact slot list the code approves and restores', async () => {
    const reference = await doc(REFERENCE);
    assert.deepEqual([...APPROVABLE_SLOTS].sort(), ['baseline', 'instructions', 'master-prompt']);
    assert.deepEqual(Object.keys(RESTORE_SLOTS).sort(), ['baseline', 'instructions', 'master-prompt']);
    for (const slot of APPROVABLE_SLOTS) {
      assert.ok(reference.includes(slot), `${REFERENCE} does not name the slot ${slot}`);
    }
  });

  it('documents the fixed destination the code actually writes', async () => {
    const reference = await doc(REFERENCE);
    for (const [slot, definition] of Object.entries(RESTORE_SLOTS)) {
      assert.ok(
        reference.includes(definition.destination),
        `${REFERENCE} does not document the destination of ${slot} (${definition.destination})`,
      );
    }
    assert.ok(/fixed in code/i.test(reference), 'the fixed-destination guarantee is not stated');
  });

  it('documents exit codes 0 through 4 exactly as the code maps them', async () => {
    const reference = await doc(REFERENCE);
    const mapper = await fs.readFile(
      path.join(packageRoot, 'continuity/internal/security-cli-error.js'), 'utf8',
    );
    // The code maps usage to 2, owner refusal to 3, trust/restore refusals to 4,
    // and everything else to 1.
    assert.match(mapper, /ERR_CLI_USAGE'\) return 2/);
    assert.match(mapper, /OWNER_REFUSAL_CODES\.has\(error\?\.code\)\) return 3/);
    assert.match(mapper, /return 4/);
    for (const code of ['0', '1', '2', '3', '4']) {
      assert.match(
        reference,
        new RegExp(`\\|\\s*${code}\\s*\\|`),
        `${REFERENCE} has no exit-code row for ${code}`,
      );
    }
    assert.ok(
      /nothing was changed/i.test(reference),
      'the reference does not say that a refusal changed nothing',
    );
  });

  it('documents the seven-day retention, and that retention is not permission', async () => {
    const reference = await doc(REFERENCE);
    assert.equal(ACTIVE_RETENTION_MS, 7 * 24 * 60 * 60 * 1000);
    assert.ok(/seven days/i.test(reference), 'the retention period is not documented');
    assert.ok(
      /retention never approves, applies, revokes, or consumes/i.test(reference),
      'the reference does not say retention confers no permission',
    );
  });

  it('documents one-shot candidate and confirmation semantics and restaging', async () => {
    const reference = await doc(REFERENCE);
    assert.ok(/one-shot/i.test(reference), 'one-shot semantics are not documented');
    assert.ok(/never be applied\s*\n?\s*twice/i.test(reference.replace(/\s+/g, ' ')),
      'the reference does not say a candidate cannot be applied twice');
    assert.ok(/[Rr]estaging is required after any failed apply/.test(reference),
      'the restaging requirement is not documented');
  });

  it('documents revoked-slot behaviour and that authority is never implied', async () => {
    const reference = await doc(REFERENCE);
    assert.ok(/revoked slot/i.test(reference), 'revoked-slot restore behaviour is not documented');
    assert.ok(
      /recomputed from the live bytes and the current manifest/i.test(reference.replace(/\s+/g, ' ')),
      'the reference does not say authority is recomputed, not asserted',
    );
  });

  it('documents crash recovery, the lock policy, and owner intervention', async () => {
    const reference = await doc(REFERENCE);
    assert.ok(/[Ee]very `restore apply` runs recovery first/.test(reference),
      'pre-apply recovery is not documented');
    assert.ok(reference.includes('noosphere restore recover'), 'the recover verb is not documented');
    assert.ok(/destination is never replaced\s*\n?\s*twice/i.test(reference.replace(/\s+/g, ' ')),
      'the no-repeat-replacement guarantee is not documented');
    assert.ok(/never reclaimed because it is old/i.test(reference),
      'the reference does not rule out age-based lock reclamation');
    assert.ok(reference.includes('ERR_RESTORE_OWNER_INTERVENTION_REQUIRED'),
      'the owner-intervention outcome is not named');
    assert.ok(/changed after the replacement committed/i.test(reference),
      'the changed-destination outcome is not documented');
  });

  it('documents every refusal class the code enforces', async () => {
    const reference = await doc(REFERENCE);
    for (const [claim, pattern] of Object.entries({
      symlink: /symlink/i,
      FIFO: /FIFO/,
      device: /device/i,
      directory: /directory in place of the file/i,
      'malformed UTF-8': /malformed UTF-8/i,
      oversize: /larger than 1 MiB/i,
      empty: /empty/i,
    })) {
      assert.match(reference, pattern, `${REFERENCE} does not document the ${claim} refusal`);
    }
    // The supported case must be stated too, or operators will read the symlink
    // refusal as broader than it is.
    assert.ok(/symlinked \*parent directory\* is supported/i.test(reference),
      'the supported symlinked-parent case is not documented');
  });

  it('documents Windows sharing-contention behaviour', async () => {
    const reference = await doc(REFERENCE);
    assert.ok(/sharing violation/i.test(reference), 'Windows sharing contention is not documented');
    assert.ok(/never falls back to a truncating write/i.test(reference),
      'the reference does not rule out a truncating fallback');
    assert.ok(/exact SID DACL/i.test(reference), 'exact SID DACLs are not documented');
  });

  it('documents the accepted PTY-relay residual', async () => {
    const reference = await doc(REFERENCE);
    assert.ok(/PTY relay/i.test(reference), 'the PTY relay residual is not documented');
    assert.ok(
      /not\*{0,2}\s*proof that a human is present/i.test(reference),
      'the reference overstates what the terminal check proves',
    );
    // SECURITY.md must carry the same residual; a reader of either must not be
    // left with the stronger claim.
    const security = await doc('SECURITY.md');
    assert.ok(/not\*{0,2} proof that a human is present/i.test(security),
      'SECURITY.md no longer carries the PTY residual');
  });

  it('states the absence of every bypass, and no operator file contradicts it', async () => {
    const reference = await doc(REFERENCE);
    for (const bypass of ['--yes', '--force', '--non-interactive', '--batch']) {
      assert.ok(reference.includes(bypass), `${REFERENCE} does not rule out ${bypass}`);
    }
    assert.ok(
      /no\*{0,2}\s*`?--yes`?/i.test(reference) || /There is \*\*no\*\* `--yes`/.test(reference),
      'the reference does not state the absence of --yes',
    );

    // Drift guard: an operator file must never instruct anyone to run an
    // authority command with a bypass flag, whatever the surrounding prose says.
    for (const relative of OPERATOR_DOCS) {
      const source = await doc(relative);
      for (const match of source.matchAll(/noosphere (?:trust|restore)[^\n`]*/g)) {
        assert.equal(
          /--yes|--force|--non-interactive|--assume-yes|--batch|--no-confirm/.test(match[0]),
          false,
          `${relative} shows an authority command with a bypass flag: ${match[0]}`,
        );
      }
    }
  });

  it('shows no authority command the CLI would reject', async () => {
    // Catches the class of drift that shipped before this test: documentation
    // for a command that was removed (the old bulk `noosphere restore`).
    const trustGrammar = /^noosphere trust (migrate|approve|revoke)(\s+(master-prompt|instructions|baseline))?$/;
    for (const relative of OPERATOR_DOCS) {
      const source = await doc(relative);
      for (const match of source.matchAll(/^\s*(noosphere (?:trust|restore)[^\n#|]*)$/gm)) {
        const command = match[1].trim().replace(/\s+#.*$/, '');
        const [, group, ...rest] = command.split(/\s+/);
        if (group === 'trust') {
          // Documentation legitimately writes the slot list as an alternation.
          const normalized = command.replace(/master-prompt\|instructions\|baseline/, 'baseline');
          assert.match(normalized, trustGrammar, `${relative}: \`${command}\` is not a valid trust command`);
          continue;
        }
        const verb = rest[0];
        assert.ok(
          ['stage', 'list', 'show', 'apply', 'recover'].includes(verb),
          `${relative}: \`${command}\` names a restore verb the CLI does not accept`,
        );
        if (verb === 'stage') {
          assert.ok(
            rest.length >= 2,
            `${relative}: \`${command}\` omits the required slot`,
          );
        }
        if (verb === 'list' || verb === 'recover') {
          assert.equal(rest.length, 1, `${relative}: \`${command}\` takes no argument`);
        }
      }
    }
  });

  it('keeps the documented terminal requirement matched to the code', async () => {
    const reference = await doc(REFERENCE);
    const cli = await fs.readFile(path.join(packageRoot, 'continuity/index.js'), 'utf8');
    const handler = functionBody(cli, 'restoreFromCli');

    // Documented as non-interactive: list, show, recover. Each must reach its
    // service without an interactive gate in the handler.
    assert.ok(/`restore list`, `restore show`, and `restore recover` do not require a terminal/
      .test(reference.replace(/\n/g, ' ')), 'the non-interactive verbs are misdocumented');
    const recoverBranch = handler.slice(
      handler.indexOf("if (parsed.verb === 'recover')"),
      handler.indexOf("if (parsed.verb === 'list')"),
    );
    assert.equal(/assertInteractive|isTTY/.test(recoverBranch), false,
      'restore recover gained a terminal gate the documentation denies');

    // Documented as interactive: the services themselves hold the gate.
    for (const [file, code] of [
      ['continuity/internal/approval-service.js', 'approval-requires-tty'],
      ['continuity/internal/revocation-service.js', 'revocation-requires-tty'],
      ['continuity/internal/restore/candidate-store.js', 'restore-stage-requires-tty'],
      ['continuity/internal/restore/apply-service.js', 'restore-apply-requires-tty'],
    ]) {
      const source = await fs.readFile(path.join(packageRoot, file), 'utf8');
      assert.ok(source.includes(code), `${file} no longer refuses without a terminal (${code})`);
    }
  });
});
