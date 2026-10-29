import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { InternalServerErrorException, Logger } from '@nestjs/common';
import type { S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getS3StorageConfig } from '../storage/s3-storage.config.js';
import { UploadsService } from './uploads.service.js';
import { MAX_UPLOAD_BYTES } from './uploads.constants.js';

const { signPost } = vi.hoisted(() => ({ signPost: vi.fn() }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomUUID: vi.fn() };
});

vi.mock('@aws-sdk/s3-presigned-post', () => ({ createPresignedPost: signPost }));

const uploadId = '123e4567-e89b-42d3-a456-426614174000';
const fixedNow = new Date('2026-01-02T03:04:05.000Z');
const s3 = {} as S3Client;
const makeService = () => new UploadsService(s3, getS3StorageConfig());

describe('UploadsService', () => {
  beforeEach(() => {
    vi.stubEnv('AWS_DEFAULT_REGION', undefined);
    vi.stubEnv('AWS_ACCESS_KEY_ID', undefined);
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', undefined);
    vi.stubEnv('AWS_SESSION_TOKEN', undefined);
    vi.stubEnv('S3_ENDPOINT_URL', undefined);
    vi.stubEnv('S3_QUARANTINE_BUCKET', undefined);
    vi.stubEnv('S3_CLEAN_BUCKET', undefined);
    vi.mocked(randomUUID).mockReturnValue(uploadId);
    vi.mocked(createPresignedPost).mockResolvedValue({
      url: 'https://storage.example.test/quarantine',
      fields: { key: `incoming/${uploadId}.pdf`, Policy: 'signed-policy' },
    });
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('creates a five-minute PDF POST policy for a generated quarantine key', async () => {
    const response = await makeService().createPresignedUpload({
      filename: 'report.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1024,
    });

    expect(response).toEqual({
      uploadId,
      url: 'https://storage.example.test/quarantine',
      fields: { key: `incoming/${uploadId}.pdf`, Policy: 'signed-policy' },
      expiresAt: '2026-01-02T03:09:05.000Z',
    });
    expect(signPost).toHaveBeenCalledWith(s3, {
      Bucket: 'doc-ai-local-quarantine',
      Key: `incoming/${uploadId}.pdf`,
      Expires: 5 * 60,
      Fields: { 'Content-Type': 'application/pdf' },
      Conditions: [
        ['eq', '$key', `incoming/${uploadId}.pdf`],
        ['eq', '$Content-Type', 'application/pdf'],
        ['content-length-range', 1, MAX_UPLOAD_BYTES],
      ],
    });
  });

  it('uses the shared storage config bucket while keeping the upload policy unchanged', async () => {
    vi.stubEnv('S3_QUARANTINE_BUCKET', 'custom-quarantine');

    await makeService().createPresignedUpload({
      filename: 'report.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1024,
    });

    expect(signPost).toHaveBeenCalledWith(s3, expect.objectContaining({ Bucket: 'custom-quarantine' }));
    expect(signPost.mock.calls[0]?.[1]).toMatchObject({
      Key: `incoming/${uploadId}.pdf`,
      Expires: 5 * 60,
      Fields: { 'Content-Type': 'application/pdf' },
      Conditions: [
        ['eq', '$key', `incoming/${uploadId}.pdf`],
        ['eq', '$Content-Type', 'application/pdf'],
        ['content-length-range', 1, MAX_UPLOAD_BYTES],
      ],
    });
  });

  it('logs presigner failures and returns a generic internal server error', async () => {
    const failure = new Error('presigner unavailable');
    const loggerError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    vi.mocked(createPresignedPost).mockRejectedValueOnce(failure);

    const thrown = await makeService()
      .createPresignedUpload({
        filename: 'report.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1024,
      })
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(InternalServerErrorException);
    const httpError = thrown as InternalServerErrorException;
    expect(thrown).toMatchObject({
      status: 500,
      response: { statusCode: 500, message: 'Failed to create presigned upload', error: 'Internal Server Error' },
    });
    expect(thrown).not.toHaveProperty('cause');
    expect(JSON.stringify(httpError.getResponse())).not.toContain(failure.message);
    expect(loggerError).toHaveBeenCalledWith('Failed to create presigned upload', failure.stack);
  });
});
