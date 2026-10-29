import { Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { randomUUID } from 'node:crypto';
import { S3_CLIENT, S3_STORAGE_CONFIG } from '../storage/s3-storage.module.js';
import type { S3StorageConfig } from '../storage/s3-storage.config.js';
import type { PresignUploadRequest, PresignedUploadResponse } from './uploads.dto.js';
import { MAX_UPLOAD_BYTES } from './uploads.constants.js';

const UPLOAD_EXPIRY_SECONDS = 5 * 60;

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);

  constructor(
    @Inject(S3_CLIENT) private readonly s3: S3Client,
    @Inject(S3_STORAGE_CONFIG) private readonly config: S3StorageConfig,
  ) {}

  async createPresignedUpload(_input: PresignUploadRequest): Promise<PresignedUploadResponse> {
    const uploadId = randomUUID();
    const key = `incoming/${uploadId}.pdf`;
    let url: string;
    let fields: Record<string, string>;
    try {
      ({ url, fields } = await createPresignedPost(this.s3, {
        Bucket: this.config.quarantineBucket,
        Key: key,
        Expires: UPLOAD_EXPIRY_SECONDS,
        Fields: { 'Content-Type': 'application/pdf' },
        Conditions: [
          ['eq', '$key', key],
          ['eq', '$Content-Type', 'application/pdf'],
          ['content-length-range', 1, MAX_UPLOAD_BYTES],
        ],
      }));
    } catch (error) {
      this.logger.error(
        'Failed to create presigned upload',
        error instanceof Error ? error.stack : String(error),
      );
      throw new InternalServerErrorException('Failed to create presigned upload');
    }

    return {
      uploadId,
      url,
      fields,
      expiresAt: new Date(Date.now() + UPLOAD_EXPIRY_SECONDS * 1000).toISOString(),
    };
  }
}
