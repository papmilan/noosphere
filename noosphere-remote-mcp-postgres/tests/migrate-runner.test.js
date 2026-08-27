import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

import * as migrationRunner from '../migrate.js';

const { orderMigrations } = migrationRunner;

describe('migration runner ordering (no DB)', () => {
  it('orders by numeric version, not lexicographically', () => {
    // Shuffled 0001..0010: lexical sort would place 0010 right after 0001.
    const names = Array.from({ length: 10 }, (_, i) => `${String(i + 1).padStart(4, '0')}_m.sql`);
    const shuffled = [names[9], names[0], names[4], names[1], ...names.slice(2, 4), ...names.slice(5, 9)];
    const ordered = orderMigrations(shuffled);
    assert.deepEqual(ordered.map((m) => m.version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(ordered.at(-1).name, '0010_m.sql');
  });

  it('rejects malformed migration names', () => {
    assert.throws(() => orderMigrations(['init.sql']), /invalid-migration-name/);
    assert.throws(() => orderMigrations(['1_init.sql']), /invalid-migration-name/);
    assert.throws(() => orderMigrations(['0001_Init.sql']), /invalid-migration-name/);
  });

  it('rejects duplicate versions', () => {
    assert.throws(() => orderMigrations(['0001_a.sql', '0001_b.sql']), /duplicate-migration-version:0001/);
  });

  it('rejects non-contiguous versions', () => {
    assert.throws(() => orderMigrations(['0001_init.sql', '0003_gap.sql']), /non-contiguous-migration-version:0003/);
  });

  it('accepts an empty set', () => {
    assert.deepEqual(orderMigrations([]), []);
  });

  it('recognizes direct execution when the script path contains spaces', () => {
    const script = '/tmp/noosphere migration test/migrate.js';
    assert.equal('isDirectRun' in migrationRunner, true);
    assert.equal(migrationRunner.isDirectRun(pathToFileURL(script).href, script), true);
    assert.equal(migrationRunner.isDirectRun(pathToFileURL('/tmp/other.js').href, script), false);
  });
});
