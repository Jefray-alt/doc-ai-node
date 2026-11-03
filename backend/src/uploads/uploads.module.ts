import { Module } from '@nestjs/common';
import { UploadsController } from './uploads.controller.js';
import { UploadsService } from './uploads.service.js';
import { UPLOADS_S3_CLIENT, createUploadsS3Client } from './uploads.service.js';
import { JobsModule } from '../jobs/jobs.module.js';

@Module({
  imports: [JobsModule],
  controllers: [UploadsController],
  providers: [
    { provide: UPLOADS_S3_CLIENT, useFactory: createUploadsS3Client },
    UploadsService,
  ],
})
export class UploadsModule {}
