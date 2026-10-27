import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { randomUUID } from 'node:crypto';
import type { PresignUploadRequest, PresignedUploadResponse } from './uploads.dto.js';
import { MAX_UPLOAD_BYTES } from './uploads.constants.js';

const UPLOAD_EXPIRY_SECONDS = 5 * 60;

@Injectable()
export class UploadsService {
  private readonly s3: S3Client;
  private readonly logger = new Logger(UploadsService.name);

  constructor() {
    const endpoint = process.env.S3_ENDPOINT_URL;
    this.s3 = new S3Client({
      region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
      ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
        ? {
            credentials: {
              accessKeyId: process.env.AWS_ACCESS_KEY_ID,
              secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            },
          }
        : {}),
    });
  }

  async createPresignedUpload(_input: PresignUploadRequest): Promise<PresignedUploadResponse> {
    const uploadId = randomUUID();
    const key = `incoming/${uploadId}.pdf`;
    const bucket = process.env.S3_QUARANTINE_BUCKET ?? 'doc-ai-local-quarantine';
    let url: string;
    let fields: Record<string, string>;
    try {
      ({ url, fields } = await createPresignedPost(this.s3, {
        Bucket: bucket,
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
