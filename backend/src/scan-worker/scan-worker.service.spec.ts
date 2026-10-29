import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { QuarantinePromotionService } from '../uploads/quarantine-promotion.service.js';
import { ScanWorkerService } from './scan-worker.service.js';
import type { ScanWorkerConfig } from './scan-worker.config.js';

const config: ScanWorkerConfig = {
  queueUrl: 'https://sqs.example.test/quarantine',
  quarantineBucket: 'quarantine',
  concurrency: 4,
  visibilityTimeoutSeconds: 120,
  processingDeadlineMs: 60_000,
  shutdownGraceMs: 65_000,
  pollIntervalMs: 250,
};

const cleanEvent = (overrides: Record<string, unknown> = {}) => ({
  id: 'event-1',
  source: 'aws.guardduty',
  'detail-type': 'GuardDuty Malware Protection Object Scan Result',
  detail: {
    resourceType: 'S3_OBJECT',
    scanStatus: 'COMPLETED',
    scanResultDetails: { scanResultStatus: 'NO_THREATS_FOUND' },
    s3ObjectDetails: {
      bucketName: 'quarantine',
      objectKey: 'incoming/123e4567-e89b-42d3-a456-426614174000.pdf',
      versionId: 'opaque-version',
      eTag: 'opaque-etag',
      extraAwsField: 'ignored',
    },
    extraAwsField: 'ignored',
  },
  ...overrides,
});

const message = (body: unknown, receiptHandle = 'receipt-1') => ({
  MessageId: 'message-1',
  ReceiptHandle: receiptHandle,
  Body: typeof body === 'string' ? body : JSON.stringify(body),
});

function makeWorker(options: {
  send?: ReturnType<typeof vi.fn>;
  promote?: ReturnType<typeof vi.fn>;
  workerConfig?: ScanWorkerConfig;
} = {}) {
  const send = options.send ?? vi.fn(async () => ({}));
  const promote = options.promote ?? vi.fn(async () => ({ status: 'promoted' as const, bucket: 'clean', key: 'cleared/key' }));
  const client = { send } as unknown as SQSClient;
  const service = { promote } as unknown as QuarantinePromotionService;
  const worker = new ScanWorkerService(client, service, options.workerConfig ?? config);
  return { worker, send, promote };
}

afterEach(() => vi.useRealTimers());

describe('ScanWorkerService', () => {
  it('promotes clean findings and deletes only after service success, normalizing quoted ETags', async () => {
    const { worker, send, promote } = makeWorker();
    await worker.processMessage(message(cleanEvent({ detail: {
      ...cleanEvent().detail,
      s3ObjectDetails: { ...cleanEvent().detail.s3ObjectDetails, eTag: '"opaque-etag"' },
    } })));
    expect(promote).toHaveBeenCalledWith(expect.objectContaining({
      uploadId: '123e4567-e89b-42d3-a456-426614174000',
      sourceKey: 'incoming/123e4567-e89b-42d3-a456-426614174000.pdf',
      versionId: 'opaque-version',
      etag: '"opaque-etag"',
      signal: expect.any(AbortSignal),
    }));
    expect(send.mock.calls.map(([command]) => command)).toEqual([expect.any(DeleteMessageCommand)]);
  });

  it('acknowledges an already-promoted duplicate after the idempotent service confirms it', async () => {
    const { worker, send, promote } = makeWorker({
      promote: vi.fn().mockResolvedValue({ status: 'already-promoted', bucket: 'clean', key: 'cleared/key' }),
    });
    await worker.processMessage(message(cleanEvent()));
    expect(promote).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toBeInstanceOf(DeleteMessageCommand);
  });

  it.each([
    ['threats', { scanStatus: 'COMPLETED', result: 'THREATS_FOUND' }],
    ['unsupported', { scanStatus: 'SKIPPED', result: 'UNSUPPORTED' }],
    ['access denied', { scanStatus: 'SKIPPED', result: 'ACCESS_DENIED' }],
    ['failed', { scanStatus: 'FAILED', result: 'FAILED' }],
  ])('acknowledges recognized non-promotions: %s', async (_name, outcome) => {
    const { worker, send, promote } = makeWorker();
    const event = cleanEvent({ detail: {
      ...cleanEvent().detail,
      scanStatus: outcome.scanStatus,
      scanResultDetails: { scanResultStatus: outcome.result },
    } });
    await worker.processMessage(message(event));
    expect(promote).not.toHaveBeenCalled();
    expect(send.mock.calls.map(([command]) => command)).toEqual([expect.any(DeleteMessageCommand)]);
  });

  it.each([
    ['source', { source: 'other' }],
    ['detail type', { 'detail-type': 'other' }],
    ['missing id', { id: '' }],
    ['wrong bucket', { detail: { ...cleanEvent().detail, s3ObjectDetails: { ...cleanEvent().detail.s3ObjectDetails, bucketName: 'other' } } }],
    ['wrong resource type', { detail: { ...cleanEvent().detail, resourceType: 'OTHER' } }],
    ['wrong key', { detail: { ...cleanEvent().detail, s3ObjectDetails: { ...cleanEvent().detail.s3ObjectDetails, objectKey: 'incoming/not-a-uuid.pdf' } } }],
    ['missing version', { detail: { ...cleanEvent().detail, s3ObjectDetails: { ...cleanEvent().detail.s3ObjectDetails, versionId: 'null' } } }],
    ['missing ETag', { detail: { ...cleanEvent().detail, s3ObjectDetails: { ...cleanEvent().detail.s3ObjectDetails, eTag: '' } } }],
    ['unsafe ETag', { detail: { ...cleanEvent().detail, s3ObjectDetails: { ...cleanEvent().detail.s3ObjectDetails, eTag: 'opaque\r\netag' } } }],
    ['unknown result', { detail: { ...cleanEvent().detail, scanResultDetails: { scanResultStatus: 'FUTURE_STATUS' } } }],
  ])('leaves malformed or unknown %s messages for retry', async (_name, override) => {
    const { worker, send, promote } = makeWorker();
    await worker.processMessage(message(cleanEvent(override)));
    expect(send).not.toHaveBeenCalled();
    expect(promote).not.toHaveBeenCalled();
  });

  it.each([
    ['CRLF', 'opaque\r\n'],
    ['non-ASCII header character', 'opaque-\u0100'],
  ])('retries clean and non-clean probes with an invalid %s ETag', async (_name, etag) => {
    for (const outcome of [
      { scanStatus: 'COMPLETED', scanResultStatus: 'NO_THREATS_FOUND' },
      { scanStatus: 'SKIPPED', scanResultStatus: 'ACCESS_DENIED' },
    ]) {
      const { worker, send, promote } = makeWorker();
      const event = cleanEvent({ detail: {
        ...cleanEvent().detail,
        ...outcome,
        scanResultDetails: { scanResultStatus: outcome.scanResultStatus },
        s3ObjectDetails: { ...cleanEvent().detail.s3ObjectDetails, eTag: etag },
      } });
      await worker.processMessage(message(event));
      expect(send).not.toHaveBeenCalled();
      expect(promote).not.toHaveBeenCalled();
    }
  });

  it('leaves a message for retry when promotion fails and when acknowledgement fails', async () => {
    const failingPromotion = makeWorker({ promote: vi.fn().mockRejectedValue(new Error('copy failed')) });
    await failingPromotion.worker.processMessage(message(cleanEvent()));
    expect(failingPromotion.send).not.toHaveBeenCalled();

    const failingDelete = makeWorker({ send: vi.fn().mockRejectedValue(new Error('delete failed')) });
    await failingDelete.worker.processMessage(message(cleanEvent()));
    expect(failingDelete.promote).toHaveBeenCalledOnce();
    expect(failingDelete.send).toHaveBeenCalledOnce();
  });

  it('uses bounded receive batches and does not acknowledge work that exceeds its deadline', async () => {
    vi.useFakeTimers();
    const blocked = vi.fn(() => new Promise(() => {}));
    const { worker, send } = makeWorker({
      promote: blocked,
      workerConfig: { ...config, processingDeadlineMs: 25 },
    });
    const handling = worker.processMessage(message(cleanEvent()));
    await vi.advanceTimersByTimeAsync(30);
    await handling;
    expect(blocked).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();

    let finishLate: (() => void) | undefined;
    const late = makeWorker({
      promote: vi.fn(() => new Promise<{ status: 'promoted'; bucket: string; key: string }>((resolve) => {
        finishLate = () => resolve({ status: 'promoted', bucket: 'clean', key: 'late' });
      })),
      workerConfig: { ...config, processingDeadlineMs: 25 },
    });
    const lateHandling = late.worker.processMessage(message(cleanEvent()));
    await vi.advanceTimersByTimeAsync(30);
    await lateHandling;
    finishLate?.();
    await Promise.resolve();
    expect(late.send).not.toHaveBeenCalled();

    const receive = makeWorker({ send: vi.fn().mockResolvedValue({ Messages: [] }) });
    const running = receive.worker.run();
    await vi.waitFor(() => expect(receive.send).toHaveBeenCalled());
    const command = receive.send.mock.calls[0][0] as ReceiveMessageCommand;
    expect(command.input).toMatchObject({
      QueueUrl: config.queueUrl,
      WaitTimeSeconds: 20,
      VisibilityTimeout: 120,
      MaxNumberOfMessages: 4,
    });
    await receive.worker.stop();
    await running;
  });

  it('caps SQS batches at ten and does not receive again while the batch fills all worker slots', async () => {
    const releases: Array<() => void> = [];
    let receives = 0;
    let inFlight = 0;
    let peakInFlight = 0;
    const send = vi.fn(async (command: ReceiveMessageCommand | DeleteMessageCommand) => {
      if (command instanceof ReceiveMessageCommand) {
        receives += 1;
        if (receives === 1) return { Messages: [message(cleanEvent(), 'r1'), message(cleanEvent({ id: 'event-2' }), 'r2')] };
        return { Messages: [] };
      }
      return {};
    });
    const promote = vi.fn(async () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise<void>((resolve) => releases.push(resolve));
      inFlight -= 1;
      return { status: 'promoted' as const, bucket: 'clean', key: 'cleared/key' };
    });
    const bounded = makeWorker({ send, promote, workerConfig: { ...config, concurrency: 2 } });
    const running = bounded.worker.run();
    await vi.waitFor(() => expect(promote).toHaveBeenCalledTimes(2));
    expect(receives).toBe(1);
    releases.forEach((release) => release());
    await vi.waitFor(() => expect(receives).toBeGreaterThanOrEqual(2));
    expect(peakInFlight).toBe(2);
    expect((send.mock.calls[0][0] as ReceiveMessageCommand).input.MaxNumberOfMessages).toBe(2);
    await bounded.worker.stop();
    await running;

    const many = makeWorker({
      send: vi.fn().mockResolvedValue({ Messages: [] }),
      workerConfig: { ...config, concurrency: 20 },
    });
    const manyRunning = many.worker.run();
    await vi.waitFor(() => expect(many.send).toHaveBeenCalled());
    expect((many.send.mock.calls[0][0] as ReceiveMessageCommand).input.MaxNumberOfMessages).toBe(10);
    await many.worker.stop();
    await manyRunning;
  });

  it('aborts active work after shutdown grace and never acknowledges it afterward', async () => {
    vi.useFakeTimers();
    let promotionSignal: AbortSignal | undefined;
    let firstReceive = true;
    const send = vi.fn(async (_command: ReceiveMessageCommand | DeleteMessageCommand) => {
      if (firstReceive) {
        firstReceive = false;
        return { Messages: [message(cleanEvent())] };
      }
      return { Messages: [] };
    });
    const promote = vi.fn(({ signal }: { signal?: AbortSignal }) => {
      promotionSignal = signal;
      return new Promise<{ status: 'promoted'; bucket: string; key: string }>(() => {});
    });
    const workerConfig = { ...config, processingDeadlineMs: 80, shutdownGraceMs: 80 };
    const shutting = makeWorker({ send, promote, workerConfig });
    const running = shutting.worker.run();
    await vi.waitFor(() => expect(promote).toHaveBeenCalledOnce());
    const stopping = shutting.worker.stop();
    await vi.advanceTimersByTimeAsync(80);
    await stopping;
    await running;
    expect(promotionSignal?.aborted).toBe(true);
    expect(send.mock.calls.some(([command]) => command instanceof DeleteMessageCommand)).toBe(false);
  });

  it('aborts the in-flight long poll during shutdown', async () => {
    let pollSignal: AbortSignal | undefined;
    const send = vi.fn((_command: ReceiveMessageCommand, options?: { abortSignal?: AbortSignal }) => {
      pollSignal = options?.abortSignal;
      return new Promise<{ Messages?: [] }>((_resolve, reject) => {
        options?.abortSignal?.addEventListener('abort', () => reject(new Error('poll aborted')), { once: true });
      });
    });
    const polling = makeWorker({ send });
    const running = polling.worker.run();
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    await polling.worker.stop();
    await running;
    expect(pollSignal?.aborted).toBe(true);
  });
});
