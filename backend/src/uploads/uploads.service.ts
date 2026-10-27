import { BadRequestException, Injectable } from '@nestjs/common';
import { S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import type { PresignUploadRequest, PresignedUploadResponse } from './uploads.dto.js';

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const UPLOAD_EXPIRY_SECONDS = 5 * 60;

@Injectable()
export class UploadsService {
  private readonly s3: S3Client;

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

  async createPresignedUpload(
    input: PresignUploadRequest | null | undefined,
  ): Promise<PresignedUploadResponse> {
    if (
      !input ||
      typeof input !== 'object' ||
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

    const uploadId = randomUUID();
    const key = `incoming/${uploadId}.pdf`;
    const bucket = process.env.S3_QUARANTINE_BUCKET ?? 'doc-ai-local-quarantine';
    const { url, fields } = await createPresignedPost(this.s3, {
      Bucket: bucket,
      Key: key,
      Expires: UPLOAD_EXPIRY_SECONDS,
      Fields: { 'Content-Type': 'application/pdf' },
      Conditions: [
        ['eq', '$key', key],
        ['eq', '$Content-Type', 'application/pdf'],
        ['content-length-range', 1, MAX_UPLOAD_BYTES],
      ],
    });

    return {
      uploadId,
      url,
      fields,
      expiresAt: new Date(Date.now() + UPLOAD_EXPIRY_SECONDS * 1000).toISOString(),
    };
  }
}
