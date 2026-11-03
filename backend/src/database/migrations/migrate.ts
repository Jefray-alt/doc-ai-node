import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { closeDatabasePool, getDatabasePool } from '../database.pool.js';

const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), 'sql');

export interface MigrationResult {
  applied: string[];
}

export async function migrateDatabase(pool: Pool = getDatabasePool()): Promise<MigrationResult> {
  const files = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  const applied: string[] = [];
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [71420511]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    for (const file of files) {
      const existing = await client.query(
        'SELECT 1 FROM schema_migrations WHERE version = $1',
        [file],
      );

      if (existing.rowCount) {
        continue;
      }

      const sql = await readFile(join(migrationsDirectory, file), 'utf8');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      applied.push(file);
    }

    await client.query('COMMIT');
    return { applied };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.loadEnvFile();
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw error;
    }
  }

  try {
    const result = await migrateDatabase();
    process.stdout.write(`Applied ${result.applied.length} database migration(s).\n`);
  } finally {
    await closeDatabasePool();
  }
}
