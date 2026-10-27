import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { UploadsService } from './uploads.service.js';
import { MAX_UPLOAD_BYTES } from './uploads.constants.js';

const { createClient, signPost } = vi.hoisted(() => ({
  createClient: vi.fn(),
  signPost: vi.fn(),
}));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomUUID: vi.fn() };
});

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    constructor(config: unknown) {
      createClient(config);
    }
  },
}));

vi.mock('@aws-sdk/s3-presigned-post', () => ({ createPresignedPost: signPost }));

const uploadId = '123e4567-e89b-42d3-a456-426614174000';
const fixedNow = new Date('2026-01-02T03:04:05.000Z');

describe('UploadsService', () => {
  beforeEach(() => {
    vi.stubEnv('AWS_DEFAULT_REGION', undefined);
    vi.stubEnv('AWS_ACCESS_KEY_ID', undefined);
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', undefined);
    vi.stubEnv('S3_ENDPOINT_URL', undefined);
    vi.stubEnv('S3_QUARANTINE_BUCKET', undefined);
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
    vi.clearAllMocks();
  });

  it('creates a five-minute PDF POST policy for a generated quarantine key', async () => {
    const service = new UploadsService();
    const response = await service.createPresignedUpload({
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
    expect(signPost).toHaveBeenCalledWith(expect.anything(), {
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

  it('uses the configured bucket and S3 client endpoint, region, and credentials', async () => {
    vi.stubEnv('AWS_DEFAULT_REGION', 'eu-west-2');
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'test-access-key');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test-secret-key');
    vi.stubEnv('S3_ENDPOINT_URL', 'http://localhost:4566');
    vi.stubEnv('S3_QUARANTINE_BUCKET', 'custom-quarantine');

    const service = new UploadsService();
    await service.createPresignedUpload({
      filename: 'report.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1024,
    });

    expect(createClient).toHaveBeenCalledWith({
      region: 'eu-west-2',
      endpoint: 'http://localhost:4566',
      forcePathStyle: true,
      credentials: {
        accessKeyId: 'test-access-key',
        secretAccessKey: 'test-secret-key',
      },
    });
    expect(signPost).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      Bucket: 'custom-quarantine',
    }));
  });

  it('uses the default region without endpoint or credentials when none are configured', () => {
    new UploadsService();

    expect(createClient).toHaveBeenCalledWith({ region: 'us-east-1' });
  });

  it('propagates presigner failures', async () => {
    const failure = new Error('presigner unavailable');
    vi.mocked(createPresignedPost).mockRejectedValueOnce(failure);
    const service = new UploadsService();

    await expect(
      service.createPresignedUpload({
        filename: 'report.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1024,
      }),
    ).rejects.toBe(failure);
  });
});
