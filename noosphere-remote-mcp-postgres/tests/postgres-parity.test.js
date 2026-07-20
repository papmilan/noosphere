import { after } from 'node:test';

import { createPool } from '../src/pool.js';
import { applyMigrations } from '../migrate.js';
import { PostgresProjectMemoryRepository } from '../src/repository.js';
import { defineParitySuite } from './parity-suite.js';

const pool = createPool();
let migrated = false;

after(async () => { await pool.end(); });

// Run the exact same behavioural contract as the in-memory reference against the
// Postgres adapter. Each case starts from an empty, migrated schema.
defineParitySuite({
  label: 'postgres adapter',
  createRepository: async () => {
    if (!migrated) { await applyMigrations(pool); migrated = true; }
    await pool.query('truncate projects, sessions, checkpoints, idempotency_receipts');
    return { repository: new PostgresProjectMemoryRepository({ pool }) };
  },
});
