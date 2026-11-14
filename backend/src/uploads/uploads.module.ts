import { Module } from '@nestjs/common';
import { UploadsController } from './uploads.controller.ts';
import { UploadsService } from './uploads.service.ts';
import { JobsModule } from '../jobs/jobs.module.ts';
import { S3Module } from '../storage/s3.module.ts';

@Module({
  imports: [JobsModule, S3Module],
  controllers: [UploadsController],
  providers: [UploadsService],
})
export class UploadsModule {}
