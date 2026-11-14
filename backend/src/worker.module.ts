import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module.ts';
import { JobsModule } from './jobs/jobs.module.ts';
import { JobsReconciler } from './jobs/jobs.reconciler.ts';
import { S3Module } from './storage/s3.module.ts';

@Module({
  imports: [DatabaseModule, JobsModule, S3Module],
  providers: [JobsReconciler],
})
export class WorkerModule {}
