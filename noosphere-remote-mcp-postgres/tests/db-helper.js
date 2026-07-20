import { createPool } from '../src/pool.js';
import { applyMigrations } from '../migrate.js';

const TABLES = 'projects, sessions, checkpoints, idempotency_receipts, retention_markers';

// One migrated pool per test file; truncate between cases for isolation.
export function dbHarness() {
  const pool = createPool();
  let migrated = false;
  return {
    pool,
    async reset() {
      if (!migrated) { await applyMigrations(pool); migrated = true; }
      await pool.query(`truncate ${TABLES}`);
    },
    async end() { await pool.end(); },
  };
}
