import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ConflictException, InternalServerErrorException, Logger, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { JobObjectConflictError } from '../jobs/jobs-storage.service.js';
import { UploadsService, createUploadsS3Client } from './uploads.service.js';
import { MAX_UPLOAD_BYTES } from './uploads.constants.js';

const { createClient, signPost } = vi.hoisted(() => ({ createClient: vi.fn(), signPost: vi.fn() }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomUUID: vi.fn() };
});

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    constructor(config: unknown) { createClient(config); }
    send() { return Promise.resolve({}); }
    destroy() {}
  },
  HeadObjectCommand: class {
    input: unknown;
    constructor(input: unknown) { this.input = input; }
  },
}));

vi.mock('@aws-sdk/s3-presigned-post', () => ({ createPresignedPost: signPost }));

const uploadId = '123e4567-e89b-42d3-a456-426614174000';
const fixedNow = new Date('2026-01-02T03:04:05.000Z');
const job = {
  uploadId,
  bucket: 'doc-ai-local-quarantine',
  key: `incoming/${uploadId}.pdf`,
  etag: '"actual-etag"',
  sizeBytes: 123,
  status: 'queued' as const,
  attempts: 0,
  lastSafeError: null,
  createdAt: fixedNow,
  updatedAt: fixedNow,
  leaseExpiresAt: null,
  ownerToken: null,
};

function setup() {
  const s3 = { send: vi.fn().mockResolvedValue({ ETag: job.etag, ContentLength: job.sizeBytes, ContentType: 'application/pdf' }), destroy: vi.fn() };
  const jobs = {
    getJobStatus: vi.fn().mockResolvedValue(null),
    createJob: vi.fn().mockResolvedValue({ created: true, job }),
  };
  return { s3, jobs, service: new UploadsService(s3 as never, jobs as never) };
}

describe('UploadsService', () => {
  beforeEach(() => {
    vi.stubEnv('AWS_DEFAULT_REGION', undefined);
    vi.stubEnv('AWS_ACCESS_KEY_ID', undefined);
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', undefined);
    vi.stubEnv('AWS_SESSION_TOKEN', undefined);
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
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('passes temporary AWS session credentials to the S3 client', () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'temporary-access');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'temporary-secret');
    vi.stubEnv('AWS_SESSION_TOKEN', 'temporary-session-token');
    createUploadsS3Client();
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({
      credentials: { accessKeyId: 'temporary-access', secretAccessKey: 'temporary-secret', sessionToken: 'temporary-session-token' },
    }));
  });

  it('creates a five-minute PDF POST policy for a generated quarantine key', async () => {
    const { service, s3, jobs } = setup();
    const response = await service.createPresignedUpload({ filename: 'report.pdf', contentType: 'application/pdf', sizeBytes: 1024 });

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
    expect(jobs.createJob).not.toHaveBeenCalled();
  });

  it('uses configured bucket and S3 client endpoint, region, and credentials', async () => {
    vi.stubEnv('AWS_DEFAULT_REGION', 'eu-west-2');
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'test-access-key');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test-secret-key');
    vi.stubEnv('S3_ENDPOINT_URL', 'http://localhost:4566');
    vi.stubEnv('S3_QUARANTINE_BUCKET', 'custom-quarantine');

    createUploadsS3Client();

    expect(createClient).toHaveBeenCalledWith({
      region: 'eu-west-2',
      endpoint: 'http://localhost:4566',
      forcePathStyle: true,
      credentials: { accessKeyId: 'test-access-key', secretAccessKey: 'test-secret-key' },
    });
    const { service, s3 } = setup();
    await service.createPresignedUpload({ filename: 'report.pdf', contentType: 'application/pdf', sizeBytes: 1024 });
    expect(signPost).toHaveBeenCalledWith(s3, expect.objectContaining({ Bucket: 'custom-quarantine' }));
  });

  it('uses the default region without endpoint or credentials when none are configured', () => {
    createUploadsS3Client();
    expect(createClient).toHaveBeenCalledWith({ region: 'us-east-1' });
  });

  it('logs presigner failures and retains the generic internal server error', async () => {
    const failure = new Error('presigner unavailable');
    const loggerError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    vi.mocked(createPresignedPost).mockRejectedValueOnce(failure);
    const { service } = setup();
    const thrown = await service.createPresignedUpload({ filename: 'report.pdf', contentType: 'application/pdf', sizeBytes: 1024 }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(InternalServerErrorException);
    expect(thrown).toMatchObject({ status: 500, response: { statusCode: 500, message: 'Failed to create presigned upload', error: 'Internal Server Error' } });
    expect(thrown).not.toHaveProperty('cause');
    expect(JSON.stringify((thrown as InternalServerErrorException).getResponse())).not.toContain(failure.message);
    expect(loggerError).toHaveBeenCalledWith('Failed to create presigned upload', failure.stack);
  });

  it('uses only the generated object reference and HEAD metadata to create a job', async () => {
    const { s3, jobs, service } = setup();
    await expect(service.completeUpload(uploadId)).resolves.toEqual({ uploadId, status: 'queued', updatedAt: fixedNow.toISOString(), error: null });
    const command = s3.send.mock.calls[0]?.[0] as HeadObjectCommand;
    expect(command).toBeInstanceOf(HeadObjectCommand);
    expect(command.input).toEqual({ Bucket: 'doc-ai-local-quarantine', Key: `incoming/${uploadId}.pdf` });
    expect(jobs.createJob).toHaveBeenCalledWith({ uploadId, bucket: 'doc-ai-local-quarantine', key: `incoming/${uploadId}.pdf`, etag: job.etag, sizeBytes: 123 });
  });

  it.each(['processing', 'source_checked', 'failed'] as const)('returns an existing %s job without checking storage or resetting its state', async (status) => {
    const { s3, jobs, service } = setup();
    jobs.getJobStatus.mockResolvedValueOnce({ ...job, status, attempts: 3, lastSafeError: status === 'failed' ? 'source unavailable' : null });
    await expect(service.completeUpload(uploadId)).resolves.toMatchObject({ status, error: status === 'failed' ? 'source unavailable' : null });
    expect(s3.send).not.toHaveBeenCalled();
    expect(jobs.createJob).not.toHaveBeenCalled();
  });

  it('requires the generated source object to exist', async () => {
    const { s3, jobs, service } = setup();
    s3.send.mockRejectedValueOnce(Object.assign(new Error('missing'), { name: 'NotFound' }));
    await expect(service.completeUpload(uploadId)).rejects.toBeInstanceOf(NotFoundException);
    expect(jobs.createJob).not.toHaveBeenCalled();
  });

  it.each([
    { ETag: '', ContentLength: 123, ContentType: 'application/pdf' },
    { ETag: 'etag', ContentLength: 0, ContentType: 'application/pdf' },
    { ETag: 'etag', ContentLength: 20 * 1024 * 1024 + 1, ContentType: 'application/pdf' },
    { ETag: 'etag', ContentLength: 1.5, ContentType: 'application/pdf' },
    { ETag: 'etag', ContentLength: 123, ContentType: 'text/plain' },
  ])('rejects invalid source metadata: %j', async (metadata) => {
    const { s3, jobs, service } = setup();
    s3.send.mockResolvedValueOnce(metadata);
    await expect(service.completeUpload(uploadId)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(jobs.createJob).not.toHaveBeenCalled();
  });

  it('maps storage permission and network errors to a safe 503', async () => {
    const { s3, jobs, service } = setup();
    s3.send.mockRejectedValueOnce(new Error('secret endpoint and credential details'));
    await expect(service.completeUpload(uploadId)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(jobs.createJob).not.toHaveBeenCalled();
  });

  it('does not treat a missing bucket or other S3 404 error as a missing upload', async () => {
    const { s3, service } = setup();
    s3.send.mockRejectedValueOnce(Object.assign(new Error('bucket unavailable'), { name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } }));
    await expect(service.completeUpload(uploadId)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('returns a conflict when a concurrent confirmation stored different metadata', async () => {
    const { jobs, service } = setup();
    jobs.createJob.mockRejectedValueOnce(new JobObjectConflictError(uploadId));
    await expect(service.completeUpload(uploadId)).rejects.toBeInstanceOf(ConflictException);
  });

  it('returns a not found status for unknown upload IDs', async () => {
    const { service } = setup();
    await expect(service.getUploadStatus(uploadId)).rejects.toBeInstanceOf(NotFoundException);
  });
});
