import { Module } from '@nestjs/common';
import { Pool } from 'pg';
import { JobsStorageService } from './jobs-storage.service.js';

const databasePool = {
  provide: Pool,
  useFactory: () => new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5_000, query_timeout: 10_000 }),
};

@Module({ providers: [databasePool, JobsStorageService], exports: [JobsStorageService] })
export class JobsModule {}
