import { describe, expect, it } from 'vitest';
import { getScanWorkerConfig } from './scan-worker.config.js';

describe('getScanWorkerConfig', () => {
  it('requires queue and quarantine bucket settings and defaults to bounded processing values', () => {
    expect(() => getScanWorkerConfig({})).toThrow('SQS_QUEUE_URL is required');
    expect(() => getScanWorkerConfig({ SQS_QUEUE_URL: 'https://sqs.example/queue' })).toThrow('S3_QUARANTINE_BUCKET is required');
    expect(getScanWorkerConfig({ SQS_QUEUE_URL: ' https://sqs.example/queue ', S3_QUARANTINE_BUCKET: 'quarantine' })).toEqual({
      queueUrl: 'https://sqs.example/queue',
      quarantineBucket: 'quarantine',
      concurrency: 4,
      visibilityTimeoutSeconds: 120,
      processingDeadlineMs: 60_000,
      shutdownGraceMs: 65_000,
      pollIntervalMs: 1_000,
    });
  });

  it('rejects settings that let processing outlive message visibility', () => {
    expect(() => getScanWorkerConfig({
      SQS_QUEUE_URL: 'https://sqs.example/queue',
      S3_QUARANTINE_BUCKET: 'quarantine',
      SQS_VISIBILITY_TIMEOUT_SECONDS: '60',
    })).toThrow('must be shorter than SQS visibility timeout');
  });
});
