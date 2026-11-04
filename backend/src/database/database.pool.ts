import { Logger } from '@nestjs/common';
import { Pool } from 'pg';

let sharedPool: Pool | undefined;
const logger = new Logger('DatabasePool');

export function getDatabasePool(): Pool {
  if (!sharedPool) {
    sharedPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      query_timeout: 15_000,
    });
    sharedPool.on('error', (error: Error) => {
      logger.error(`Unexpected idle PostgreSQL client error: ${error.message}`);
    });
  }

  return sharedPool;
}

export async function closeDatabasePool(): Promise<void> {
  const pool = sharedPool;
  sharedPool = undefined;

  if (pool) {
    await pool.end();
  }
}
