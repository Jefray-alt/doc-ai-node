import { describe, expect, it } from 'vitest';
import { parseWorkerConfig } from './worker.config.js';

describe('worker configuration', () => {
  it('uses bounded queue, lease, and retry defaults', () => {
    expect(parseWorkerConfig({
      DATABASE_URL: 'postgres://localhost/docai',
      SQS_QUEUE_URL: 'http://localhost:4566/queue',
      SQS_DLQ_URL: 'http://localhost:4566/dlq',
      S3_QUARANTINE_BUCKET: 'quarantine',
    })).toMatchObject({
      pollWaitSeconds: 20,
      receiveMax: 1,
      visibilityTimeoutSeconds: 120,
      leaseMs: 120_000,
      heartbeatMs: 30_000,
      retryDelaySeconds: 1,
      retryDelayMaxSeconds: 300,
    });
  });

  it('rejects unsafe timing and queue bounds', () => {
    expect(() => parseWorkerConfig({
      DATABASE_URL: 'postgres://localhost/docai', SQS_QUEUE_URL: 'main', SQS_DLQ_URL: 'dlq',
      S3_QUARANTINE_BUCKET: 'quarantine', WORKER_HEARTBEAT_MS: '120000',
    })).toThrow(/heartbeat/i);
    expect(() => parseWorkerConfig({
      DATABASE_URL: 'postgres://localhost/docai', SQS_QUEUE_URL: 'main', SQS_DLQ_URL: 'dlq',
      S3_QUARANTINE_BUCKET: 'quarantine', WORKER_RECEIVE_MAX: '2',
    })).toThrow(/receive/i);
    expect(() => parseWorkerConfig({
      DATABASE_URL: 'postgres://localhost/docai', SQS_QUEUE_URL: 'main', SQS_DLQ_URL: 'dlq',
      S3_QUARANTINE_BUCKET: 'quarantine', WORKER_POLL_WAIT_SECONDS: '0',
    })).toThrow(/WORKER_POLL_WAIT_SECONDS/);
    expect(() => parseWorkerConfig({
      DATABASE_URL: 'postgres://localhost/docai', SQS_QUEUE_URL: 'main', SQS_DLQ_URL: 'dlq',
      S3_QUARANTINE_BUCKET: 'quarantine', WORKER_RETRY_DELAY_SECONDS: '5', WORKER_RETRY_DELAY_MAX_SECONDS: '4',
    })).toThrow(/maximum/i);
  });
});
