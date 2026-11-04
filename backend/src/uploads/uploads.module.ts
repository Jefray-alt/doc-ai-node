import { Module } from '@nestjs/common';
import { UploadsController } from './uploads.controller.js';
import { UploadsService } from './uploads.service.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { S3Module } from '../storage/s3.module.js';

@Module({
  imports: [JobsModule, S3Module],
  controllers: [UploadsController],
  providers: [UploadsService],
})
export class UploadsModule {}
