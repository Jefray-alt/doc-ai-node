import { Body, Controller, Post } from '@nestjs/common';
import { UploadsService } from './uploads.service.js';
import type { PresignUploadRequest } from './uploads.dto.js';

@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  @Post('presign')
  createPresignedUpload(@Body() body: PresignUploadRequest) {
    return this.uploadsService.createPresignedUpload(body);
  }
}
