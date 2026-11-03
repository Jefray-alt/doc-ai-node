import { Module } from '@nestjs/common';
import { DATABASE_POOL } from '../database/database.module.js';
import type { Pool } from 'pg';
import { JobsRepository } from './jobs.repository.js';

@Module({
  providers: [
    {
      provide: JobsRepository,
      inject: [DATABASE_POOL],
      useFactory: (pool: Pool) => new JobsRepository(pool),
    },
  ],
  exports: [JobsRepository],
})
export class JobsModule {}
