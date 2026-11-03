import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { UploadsModule } from './uploads/uploads.module.js';

@Module({ imports: [DatabaseModule, JobsModule, HealthModule, UploadsModule] })
export class AppModule {}
