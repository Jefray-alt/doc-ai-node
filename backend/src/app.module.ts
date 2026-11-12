import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { UploadsModule } from './uploads/uploads.module.js';

@Module({ imports: [DatabaseModule, HealthModule, UploadsModule] })
export class AppModule {}
