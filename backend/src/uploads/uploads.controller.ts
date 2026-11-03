import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, UsePipes } from '@nestjs/common';
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

  @Post(':uploadId/complete')
  @HttpCode(202)
  completeUpload(@Param('uploadId', new ParseUUIDPipe({ version: '4' })) uploadId: string) {
    return this.uploadsService.completeUpload(uploadId);
  }

  @Get(':uploadId/status')
  getUploadStatus(@Param('uploadId', new ParseUUIDPipe({ version: '4' })) uploadId: string) {
    return this.uploadsService.getUploadStatus(uploadId);
  }
}
