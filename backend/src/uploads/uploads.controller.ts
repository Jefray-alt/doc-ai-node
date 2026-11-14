import { Body, Controller, Post, UsePipes } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import { UploadsService } from './uploads.service.ts';
import { PresignUploadDto } from './uploads.dto.ts';

@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  @Post('presign')
  @UsePipes(ZodValidationPipe)
  createPresignedUpload(@Body() body: PresignUploadDto) {
    return this.uploadsService.createPresignedUpload(body);
  }
}
