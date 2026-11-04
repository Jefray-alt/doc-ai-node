import { Module } from '@nestjs/common';
import { JobsRepository } from './jobs.repository.js';
import { JobsReconciler } from './jobs.reconciler.js';
import { S3Module } from '../storage/s3.module.js';

@Module({
  imports: [S3Module],
  providers: [JobsRepository, JobsReconciler],
  exports: [JobsRepository],
})
export class JobsModule {}
