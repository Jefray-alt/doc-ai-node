import { Body, Controller, Post, UsePipes } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import { UploadsService } from './uploads.service.js';
import { PresignUploadDto } from './uploads.dto.js';

@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  @Post('presign')
  @UsePipes(ZodValidationPipe)
  createPresignedUpload(@Body() body: PresignUploadDto) {
    return this.uploadsService.createPresignedUpload(body);
  }
}
