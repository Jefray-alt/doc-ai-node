import { Module } from '@nestjs/common';
import { UploadsController } from './uploads.controller.js';
import { UploadsService } from './uploads.service.js';
import { JobsModule } from '../jobs/jobs.module.js';

@Module({
  imports: [JobsModule],
  controllers: [UploadsController],
  providers: [UploadsService],
})
export class UploadsModule {}
