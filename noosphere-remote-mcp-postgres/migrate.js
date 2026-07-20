import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MIGRATION_NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;

// Pure, DB-free: parse + strictly order migration filenames by numeric version.
// Rejects malformed names, duplicate versions, and gaps so the applied order is
// deterministic and total. Exported for unit testing without a database.
export function orderMigrations(filenames) {
  const seen = new Map();
  for (const name of filenames) {
    const match = MIGRATION_NAME.exec(name);
    if (!match) throw new Error(`invalid-migration-name:${name}`);
    const version = Number(match[1]);
    if (seen.has(version)) throw new Error(`duplicate-migration-version:${match[1]}`);
    seen.set(version, name);
  }
  const ordered = [...seen.entries()].sort(([a], [b]) => a - b);
  ordered.forEach(([version], index) => {
    if (version !== index + 1) throw new Error(`non-contiguous-migration-version:${String(version).padStart(4, '0')}`);
  });
  return ordered.map(([version, name]) => ({ version, name }));
}

export function readMigrations(dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations')) {
  const ordered = orderMigrations(readdirSync(dir).filter((name) => name.endsWith('.sql')));
  return ordered.map((entry) => ({ ...entry, sql: readFileSync(join(dir, entry.name), 'utf8') }));
}

const SCHEMA_MIGRATIONS = `
  create table if not exists schema_migrations (
    version integer primary key,
    name text not null,
    applied_at timestamptz not null default now()
  )`;

// Apply every not-yet-applied migration in order, each in its own transaction.
export async function applyMigrations(pool, migrations = readMigrations()) {
  await pool.query(SCHEMA_MIGRATIONS);
  const { rows } = await pool.query('select version from schema_migrations');
  const applied = new Set(rows.map((row) => row.version));
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(migration.sql);
      await client.query('insert into schema_migrations (version, name) values ($1, $2)', [migration.version, migration.name]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw new Error(`migration-failed:${migration.name}:${error.message}`);
    } finally {
      client.release();
    }
  }
  return migrations.map((migration) => migration.version);
}

// CLI entry: `node migrate.js` applies migrations to DATABASE_URL.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const versions = await applyMigrations(pool);
    console.log(`applied migrations up to version ${versions.at(-1) ?? 0}`);
  } finally {
    await pool.end();
  }
}
