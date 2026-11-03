import { Module } from '@nestjs/common';
import { DATABASE_POOL } from '../database/database.module.js';
import type { Pool } from 'pg';
import { JobsRepository } from './jobs.repository.js';
import { JobsReconciler } from './jobs.reconciler.js';
import { S3Module } from '../storage/s3.module.js';

@Module({
  imports: [S3Module],
  providers: [
    {
      provide: JobsRepository,
      inject: [DATABASE_POOL],
      useFactory: (pool: Pool) => new JobsRepository(pool),
    },
    JobsReconciler,
  ],
  exports: [JobsRepository],
})
export class JobsModule {}
