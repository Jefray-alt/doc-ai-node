import { afterEach, describe, expect, it, vi } from 'vitest';
import { getS3StorageConfig } from './s3-storage.config.js';
import { createS3Client } from './s3-storage.module.js';

const { clientConfig } = vi.hoisted(() => ({ clientConfig: vi.fn() }));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    constructor(config: unknown) {
      clientConfig(config);
    }
  },
}));

describe('shared S3 storage configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('uses stable local bucket defaults and leaves credentials to the AWS provider chain', () => {
    const config = getS3StorageConfig({});

    expect(config).toEqual({
      region: 'us-east-1',
      quarantineBucket: 'doc-ai-local-quarantine',
      cleanBucket: 'doc-ai-local-pdfs',
    });
    expect(config.credentials).toBeUndefined();
    createS3Client(config);
    expect(clientConfig).toHaveBeenCalledWith({ region: 'us-east-1' });
  });

  it('uses configured endpoint and static credentials including the AWS session token', () => {
    const config = getS3StorageConfig({
      AWS_DEFAULT_REGION: 'eu-west-2',
      AWS_ACCESS_KEY_ID: 'access',
      AWS_SECRET_ACCESS_KEY: 'secret',
      AWS_SESSION_TOKEN: 'session',
      S3_ENDPOINT_URL: 'http://localhost:4566',
      S3_QUARANTINE_BUCKET: 'custom-quarantine',
      S3_CLEAN_BUCKET: 'custom-clean',
    });

    expect(config).toEqual({
      region: 'eu-west-2',
      endpoint: 'http://localhost:4566',
      quarantineBucket: 'custom-quarantine',
      cleanBucket: 'custom-clean',
      credentials: { accessKeyId: 'access', secretAccessKey: 'secret', sessionToken: 'session' },
    });
    createS3Client(config);
    expect(clientConfig).toHaveBeenCalledWith({
      region: 'eu-west-2',
      endpoint: 'http://localhost:4566',
      forcePathStyle: true,
      credentials: { accessKeyId: 'access', secretAccessKey: 'secret', sessionToken: 'session' },
    });
  });
});
