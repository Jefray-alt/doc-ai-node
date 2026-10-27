import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module.js';
import { UploadsModule } from './uploads/uploads.module.js';

@Module({ imports: [HealthModule, UploadsModule] })
export class AppModule {}
