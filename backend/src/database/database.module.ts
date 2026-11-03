import { Global, Module } from '@nestjs/common';
import { closeDatabasePool, getDatabasePool } from './database.pool.js';

export const DATABASE_POOL = Symbol('DATABASE_POOL');

class DatabasePoolLifecycle {
  async onApplicationShutdown(): Promise<void> {
    await closeDatabasePool();
  }
}

@Global()
@Module({
  providers: [
    { provide: DATABASE_POOL, useFactory: getDatabasePool },
    DatabasePoolLifecycle,
  ],
  exports: [DATABASE_POOL],
})
export class DatabaseModule {}
