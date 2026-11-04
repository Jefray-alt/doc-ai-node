import { Module } from '@nestjs/common';
import { S3StorageModule } from '../storage/s3-storage.module.js';
import { UploadsController } from './uploads.controller.js';
import { QuarantinePromotionService } from './quarantine-promotion.service.js';
import { UploadsService } from './uploads.service.js';

@Module({
  imports: [S3StorageModule],
  controllers: [UploadsController],
  providers: [UploadsService, QuarantinePromotionService],
  exports: [QuarantinePromotionService],
})
export class UploadsModule {}
