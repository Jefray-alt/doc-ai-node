import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';

const { clientConfigs } = vi.hoisted(() => ({ clientConfigs: [] as unknown[] }));

vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class {
    constructor(config: unknown) {
      clientConfigs.push(config);
    }
  },
}));

import { createSqsClient } from './scan-worker.module.js';

describe('createSqsClient', () => {
  it('uses shared AWS region and session credentials with a dedicated SQS endpoint', () => {
    createSqsClient({
      AWS_DEFAULT_REGION: 'eu-west-2',
      AWS_ACCESS_KEY_ID: 'access',
      AWS_SECRET_ACCESS_KEY: 'secret',
      AWS_SESSION_TOKEN: 'session',
      S3_ENDPOINT_URL: 'http://s3.local',
      SQS_ENDPOINT_URL: 'http://sqs.local',
    });
    expect(clientConfigs.at(-1)).toEqual({
      region: 'eu-west-2',
      endpoint: 'http://sqs.local',
      credentials: { accessKeyId: 'access', secretAccessKey: 'secret', sessionToken: 'session' },
    });
  });
});
