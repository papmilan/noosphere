import pg from 'pg';

const { Pool } = pg;

// The core repository stores ISO-8601 strings; keep timestamptz columns (only in
// idempotency_receipts.created_at, which the port never returns) as strings too
// so nothing in a returned document is silently coerced to a Date.
pg.types.setTypeParser(1184, (value) => value); // timestamptz
pg.types.setTypeParser(1114, (value) => value); // timestamp

const DEFAULT_URL = 'postgres://noosphere:noosphere@127.0.0.1:5433/noosphere_project_memory';

export function createPool(connectionString = process.env.DATABASE_URL ?? DEFAULT_URL) {
  return new Pool({ connectionString, max: 10 });
}

// Mirrors the in-memory repository's owner-scope guard exactly so the adapter
// rejects the same inputs with the same error.
export function assertOwnerScope(ownerScope) {
  if (typeof ownerScope !== 'string' || ownerScope.length < 3 || ownerScope.length > 512) {
    throw new Error('invalid-owner-scope');
  }
}

// Run fn inside a single transaction; commit on success, roll back on any throw.
export async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      // The original error is the meaningful one; ignore rollback failures.
    }
    throw error;
  } finally {
    client.release();
  }
}
