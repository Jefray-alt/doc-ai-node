import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { JobsReconciler } from './jobs/jobs.reconciler.js';
import { S3Module } from './storage/s3.module.js';

@Module({
  imports: [DatabaseModule, JobsModule, S3Module],
  providers: [JobsReconciler],
})
export class WorkerModule {}
