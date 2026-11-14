import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module.ts';
import { HealthModule } from './health/health.module.ts';
import { UploadsModule } from './uploads/uploads.module.ts';

@Module({ imports: [DatabaseModule, HealthModule, UploadsModule] })
export class AppModule {}
