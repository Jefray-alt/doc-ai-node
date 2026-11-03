import { ConflictException, Inject, Injectable, InternalServerErrorException, Logger, NotFoundException, ServiceUnavailableException, UnprocessableEntityException, type OnModuleDestroy } from '@nestjs/common';
import { HeadObjectCommand, S3Client, type HeadObjectCommandOutput } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { randomUUID } from 'node:crypto';
import type { PresignUploadRequest, PresignedUploadResponse } from './uploads.dto.js';
import { MAX_UPLOAD_BYTES } from './uploads.constants.js';
import { JobsStorageService, JobObjectConflictError } from '../jobs/jobs-storage.service.js';
import type { JobRecord } from '../jobs/jobs.types.js';

const UPLOAD_EXPIRY_SECONDS = 5 * 60;
export const UPLOADS_S3_CLIENT = Symbol('UPLOADS_S3_CLIENT');

@Injectable()
export class UploadsService implements OnModuleDestroy {
  private readonly logger = new Logger(UploadsService.name);

  constructor(
    @Inject(UPLOADS_S3_CLIENT) private readonly s3: S3Client,
    private readonly jobs: JobsStorageService,
  ) {}

  onModuleDestroy(): void {
    this.s3.destroy();
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

  async completeUpload(uploadId: string): Promise<UploadStatusResponse> {
    try {
      const existing = await this.jobs.getJobStatus(uploadId);
      if (existing) return toUploadStatus(existing);
    } catch {
      throw new ServiceUnavailableException('Upload status is unavailable');
    }

    const bucket = process.env.S3_QUARANTINE_BUCKET ?? 'doc-ai-local-quarantine';
    const key = `incoming/${uploadId}.pdf`;
    let head: HeadObjectCommandOutput;
    try {
      head = await this.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    } catch (error) {
      if (isMissingObject(error)) throw new NotFoundException('Uploaded PDF was not found');
      this.logger.warn('Upload source metadata is unavailable');
      throw new ServiceUnavailableException('Upload storage is unavailable');
    }

    const metadata = head;
    const sizeBytes = metadata.ContentLength;
    const etag = metadata.ETag;
    if (
      !etag?.trim() ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes! < 1 ||
      sizeBytes! > MAX_UPLOAD_BYTES ||
      metadata.ContentType?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/pdf'
    ) {
      throw new UnprocessableEntityException('Uploaded object metadata is invalid');
    }

    try {
      const result = await this.jobs.createJob({ uploadId, bucket, key, etag, sizeBytes: sizeBytes! });
      return toUploadStatus(result.job);
    } catch (error) {
      if (error instanceof JobObjectConflictError) throw new ConflictException('Upload was already confirmed with different object metadata');
      throw new ServiceUnavailableException('Upload status is unavailable');
    }
  }

  async getUploadStatus(uploadId: string): Promise<UploadStatusResponse> {
    let job: JobRecord | null;
    try {
      job = await this.jobs.getJobStatus(uploadId);
    } catch {
      throw new ServiceUnavailableException('Upload status is unavailable');
    }
    if (!job) throw new NotFoundException('Upload was not found');
    return toUploadStatus(job);
  }
}

export type UploadStatusResponse = {
  uploadId: string;
  status: JobRecord['status'];
  updatedAt: string;
  error: string | null;
};

export function createUploadsS3Client(): S3Client {
  const endpoint = process.env.S3_ENDPOINT_URL;
  return new S3Client({
    region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? { credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY } }
      : {}),
  });
}

function toUploadStatus(job: JobRecord): UploadStatusResponse {
  return {
    uploadId: job.uploadId,
    status: job.status,
    updatedAt: job.updatedAt.toISOString(),
    error: job.status === 'failed' ? job.lastSafeError : null,
  };
}

function isMissingObject(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: string; Code?: string; code?: string };
  return candidate.name === 'NoSuchKey' || candidate.name === 'NotFound' || candidate.Code === 'NoSuchKey' || candidate.code === 'NoSuchKey';
}
