import {
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { randomUUID } from 'node:crypto';
import type { PresignUploadRequest, PresignedUploadResponse } from './uploads.dto.js';
import { MAX_UPLOAD_BYTES } from './uploads.constants.js';
import { JobsRepository } from '../jobs/jobs.repository.js';

const UPLOAD_EXPIRY_SECONDS = 5 * 60;

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);

  constructor(
    private readonly jobs: JobsRepository,
    private readonly s3: S3Client,
  ) {}

  async createPresignedUpload(_input: PresignUploadRequest): Promise<PresignedUploadResponse> {
    const uploadId = randomUUID();
    const key = `incoming/${uploadId}.pdf`;
    const bucket = process.env.S3_BUCKET_NAME ?? 'doc-ai-local-pdfs';
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
        `Failed to create presigned upload for ${uploadId}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new InternalServerErrorException('Failed to create presigned upload');
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + UPLOAD_EXPIRY_SECONDS * 1000);

    try {
      await this.jobs.create({
        uploadId,
        bucket,
        objectKey: key,
        status: 'awaiting_upload',
        uploadExpiresAt: expiresAt,
        nextCheckAt: now,
      });
    } catch (error) {
      this.logger.error(
        `Failed to persist upload authorization for ${uploadId}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new ServiceUnavailableException('Upload service unavailable');
    }

    this.logger.log(
      `Upload authorization created for ${uploadId} (status=awaiting_upload, expiresAt=${expiresAt.toISOString()})`,
    );

    return {
      uploadId,
      url,
      fields,
      expiresAt: expiresAt.toISOString(),
    };
  }
}
