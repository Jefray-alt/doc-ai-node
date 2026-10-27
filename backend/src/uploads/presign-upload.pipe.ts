import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import { extname } from 'node:path';
import type { PresignUploadRequest } from './uploads.dto.js';
import { MAX_UPLOAD_BYTES } from './uploads.constants.js';

@Injectable()
export class PresignUploadPipe implements PipeTransform<unknown, PresignUploadRequest> {
  transform(value: unknown): PresignUploadRequest {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException('Upload must be a PDF between 1 byte and 20 MiB.');
    }

    const input = value as Record<string, unknown>;
    if (
      typeof input.filename !== 'string' ||
      extname(input.filename).toLowerCase() !== '.pdf' ||
      input.contentType !== 'application/pdf' ||
      typeof input.sizeBytes !== 'number' ||
      !Number.isInteger(input.sizeBytes) ||
      input.sizeBytes < 1 ||
      input.sizeBytes > MAX_UPLOAD_BYTES
    ) {
      throw new BadRequestException('Upload must be a PDF between 1 byte and 20 MiB.');
    }

    return {
      filename: input.filename as string,
      contentType: input.contentType as string,
      sizeBytes: input.sizeBytes as number,
    };
  }
}
