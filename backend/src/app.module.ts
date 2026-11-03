import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module.js';
import { UploadsModule } from './uploads/uploads.module.js';
import { JobsModule } from './jobs/jobs.module.js';

@Module({ imports: [HealthModule, UploadsModule, JobsModule] })
export class AppModule {}
