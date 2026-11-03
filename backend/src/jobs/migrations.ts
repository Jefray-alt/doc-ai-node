import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';

const migrationDirectory = resolve(dirname(fileURLToPath(import.meta.url)), 'migrations');
const migrationLockId = 741_953_112;

export async function runMigrations(pool: Pool): Promise<void> {
  const files = (await readdir(migrationDirectory)).filter((file) => /^\d+_[\w-]+\.sql$/.test(file)).sort();
  const client = await pool.connect();

  try {
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())');

    for (const file of files) {
      const version = file.slice(0, file.length - '.sql'.length);
      await applyMigration(client, version, await readFile(resolve(migrationDirectory, file), 'utf8'));
    }
  } finally {
    client.release();
  }
}

async function applyMigration(client: PoolClient, version: string, sql: string): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock($1)', [migrationLockId]);
    const found = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version]);
    if (found.rowCount === 0) {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
