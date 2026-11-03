import { Pool } from 'pg';
import { runMigrations } from './migrations.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL must be set to run migrations');
}

const pool = new Pool({ connectionString });
try {
  await runMigrations(pool);
} finally {
  await pool.end();
}
