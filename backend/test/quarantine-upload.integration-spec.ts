import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { Message } from '@aws-sdk/client-sqs';
import { AppModule } from '../src/app.module.js';
import { ScanWorkerModule } from '../src/scan-worker/scan-worker.module.js';
import { ScanWorkerService } from '../src/scan-worker/scan-worker.service.js';

const execFileAsync = promisify(execFile);
const endpoint = process.env.S3_ENDPOINT_URL ?? process.env.FLOCI_TEST_ENDPOINT_URL ?? 'http://localhost:4566';
const s3Bucket = process.env.S3_CLEAN_BUCKET ?? 'doc-ai-local-pdfs';
const quarantineBucket = process.env.S3_QUARANTINE_BUCKET ?? 'doc-ai-local-quarantine';
const queuePrefix = `doc-ai-floci-test-${process.pid}-${Date.now()}`;
const region = process.env.AWS_DEFAULT_REGION ?? 'us-east-1';
const credentials = { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test' };
const uploadedKeys: string[] = [];

process.env.AWS_DEFAULT_REGION = region;
process.env.AWS_ACCESS_KEY_ID = credentials.accessKeyId;
process.env.AWS_SECRET_ACCESS_KEY = credentials.secretAccessKey;
process.env.S3_ENDPOINT_URL = endpoint;
process.env.S3_QUARANTINE_BUCKET = quarantineBucket;
process.env.S3_CLEAN_BUCKET = s3Bucket;
process.env.SQS_ENDPOINT_URL = process.env.SQS_ENDPOINT_URL ?? endpoint;
process.env.SCAN_WORKER_CONCURRENCY = '1';
process.env.SQS_VISIBILITY_TIMEOUT_SECONDS = '2';
process.env.SCAN_WORKER_DEADLINE_MS = '1000';
process.env.SCAN_WORKER_SHUTDOWN_GRACE_MS = '1500';
process.env.SCAN_WORKER_POLL_BACKOFF_MS = '100';

const s3 = new S3Client({ region, endpoint, forcePathStyle: true, credentials });
const sqs = new SQSClient({ region, endpoint: process.env.SQS_ENDPOINT_URL, credentials });

type QueuePair = { queueUrl: string; dlqUrl: string };
let app: INestApplication;
let testQueue!: QueuePair;
let retryQueue!: QueuePair;

describe('Quarantine promotion against isolated Floci', () => {
  beforeAll(async () => {
    await ensureBucket(s3Bucket);
    await ensureBucket(quarantineBucket);
    await s3.send(new CreateBucketCommand({ Bucket: s3Bucket })).catch((error: unknown) => {
      if (!isAlreadyExists(error)) throw error;
    });
    await s3.send(new CreateBucketCommand({ Bucket: quarantineBucket })).catch((error: unknown) => {
      if (!isAlreadyExists(error)) throw error;
    });
    await testQueueSetup(`${queuePrefix}-main`, `${queuePrefix}-dlq`, 5);
    await retryQueueSetup(`${queuePrefix}-retry`, `${queuePrefix}-retry-dlq`);
    process.env.SQS_QUEUE_URL = testQueue.queueUrl;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    for (const pair of [testQueue, retryQueue]) {
      if (!pair) continue;
      await sqs.send(new DeleteQueueCommand({ QueueUrl: pair.queueUrl })).catch(() => undefined);
      await sqs.send(new DeleteQueueCommand({ QueueUrl: pair.dlqUrl })).catch(() => undefined);
    }
    for (const key of uploadedKeys) await deleteUploadArtifacts(key).catch(() => undefined);
    s3.destroy();
    sqs.destroy();
  });

  it('uploads via the signed browser POST, scans exact versions through SQS, and promotes only clean versions', async () => {
    const key = await signedUpload('integration.pdf', '%PDF-1.7 first version bytes');
    const first = await s3.send(new HeadObjectCommand({ Bucket: quarantineBucket, Key: key }));
    const second = await s3.send(new PutObjectCommand({ Bucket: quarantineBucket, Key: key, Body: '%PDF-1.7 replacement bytes' }));
    expect(first.VersionId).toBeTruthy();
    expect(second.VersionId).toBeTruthy();
    expect(second.VersionId).not.toBe(first.VersionId);
    expect(await cleanObjectsForUpload(key)).toHaveLength(0);

    await simulate(key, 'clean', second.VersionId);
    await simulate(key, 'clean', first.VersionId);
    await simulate(key, 'clean', second.VersionId);
    await withWorker(testQueue.queueUrl, async () => {
      await waitFor(async () => {
        const firstClean = await promotedBody(key, first.VersionId!);
        const secondClean = await promotedBody(key, second.VersionId!);
        const counts = await queueCounts(testQueue.queueUrl);
        return firstClean === '%PDF-1.7 first version bytes'
          && secondClean === '%PDF-1.7 replacement bytes'
          && counts.visible === 0
          && counts.inFlight === 0;
      });
    });

    const firstCleanKey = cleanKey(key, first.VersionId!);
    const secondCleanKey = cleanKey(key, second.VersionId!);
    expect((await s3.send(new HeadObjectCommand({ Bucket: s3Bucket, Key: firstCleanKey }))).Metadata).toMatchObject({
      'source-bucket': quarantineBucket,
      'source-key': key,
      'source-version-id': first.VersionId,
    });
    expect((await s3.send(new HeadObjectCommand({ Bucket: s3Bucket, Key: secondCleanKey }))).Metadata).toMatchObject({
      'source-bucket': quarantineBucket,
      'source-key': key,
      'source-version-id': second.VersionId,
    });
    await expect(s3.send(new HeadObjectCommand({ Bucket: quarantineBucket, Key: key, VersionId: first.VersionId })))
      .resolves.toMatchObject({ $metadata: { httpStatusCode: 200 } });
    await expect(s3.send(new HeadObjectCommand({ Bucket: quarantineBucket, Key: key, VersionId: second.VersionId })))
      .resolves.toMatchObject({ $metadata: { httpStatusCode: 200 } });
    expect(await sourceBody(key, first.VersionId!)).toBe('%PDF-1.7 first version bytes');
    expect(await sourceBody(key, second.VersionId!)).toBe('%PDF-1.7 replacement bytes');
    expect(await receiveAvailable(testQueue.queueUrl)).toHaveLength(0);
    await deleteVersions(quarantineBucket, key);
    await deleteVersions(s3Bucket, firstCleanKey);
    await deleteVersions(s3Bucket, secondCleanKey);
  }, 30_000);

  it('acknowledges completed threats, unsupported, access denied, and failed scan results without creating clean objects', async () => {
    const key = await signedUpload('negative.pdf', '%PDF-1.7 negative outcome bytes');
    const head = await s3.send(new HeadObjectCommand({ Bucket: quarantineBucket, Key: key }));
    for (const outcome of ['threats', 'unsupported', 'accessdenied', 'failed']) {
      await simulate(key, outcome, head.VersionId);
    }
    await withWorker(testQueue.queueUrl, async () => {
      await waitFor(async () => (await queueCounts(testQueue.queueUrl)).visible === 0
        && (await queueCounts(testQueue.queueUrl)).inFlight === 0);
    });
    expect(await cleanObjectsForUpload(key)).toHaveLength(0);
    await deleteVersions(quarantineBucket, key);
  }, 20_000);

  it('leaves ETag mismatch and missing-version events unacknowledged until the processing DLQ receives them', async () => {
    const key = await signedUpload('retry.pdf', '%PDF-1.7 retry bytes');
    const head = await s3.send(new HeadObjectCommand({ Bucket: quarantineBucket, Key: key }));
    await sqs.send(new SendMessageCommand({
      QueueUrl: retryQueue.queueUrl,
      MessageBody: scanEvent(key, head.VersionId!, '"deliberately-wrong-etag"'),
    }));
    await sqs.send(new SendMessageCommand({
      QueueUrl: retryQueue.queueUrl,
      MessageBody: scanEvent(key, 'missing-version-not-present-in-bucket', head.ETag!),
    }));

    await withWorker(retryQueue.queueUrl, async () => {
      await waitFor(async () => (await queueCounts(retryQueue.dlqUrl)).visible === 2, 15_000);
    });
    expect(await cleanObjectsForUpload(key)).toHaveLength(0);
    await deleteVersions(quarantineBucket, key);
  }, 25_000);
});

async function ensureBucket(bucket: string): Promise<void> {
  await s3.send(new HeadBucketCommand({ Bucket: bucket })).catch((error: unknown) => {
    if (!isNotFound(error)) throw error;
  });
}

function isAlreadyExists(error: unknown): boolean {
  return error !== null && typeof error === 'object'
    && ['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes((error as { name?: string }).name ?? '');
}

function isNotFound(error: unknown): boolean {
  return error !== null && typeof error === 'object'
    && ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404
      || ['NotFound', 'NoSuchBucket', 'NoSuchKey'].includes((error as { name?: string }).name ?? ''));
}

async function testQueueSetup(queueName: string, dlqName: string, maxReceiveCount: number): Promise<void> {
  testQueue = await createQueuePair(queueName, dlqName, maxReceiveCount, 2, 345_600);
}

async function retryQueueSetup(queueName: string, dlqName: string): Promise<void> {
  retryQueue = await createQueuePair(queueName, dlqName, 1, 2, 86_400);
}

async function createQueuePair(queueName: string, dlqName: string, maxReceiveCount: number, visibility: number, retention: number): Promise<QueuePair> {
  const dlqUrl = await sqs.send(new CreateQueueCommand({ QueueName: dlqName, Attributes: { MessageRetentionPeriod: '1209600' } }))
    .then((result) => result.QueueUrl!);
  const dlqArn = await awaitQueueArn(dlqUrl);
  const queueUrl = await sqs.send(new CreateQueueCommand({ QueueName: queueName, Attributes: {
    VisibilityTimeout: String(visibility),
    MessageRetentionPeriod: String(retention),
    ReceiveMessageWaitTimeSeconds: '0',
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: String(maxReceiveCount) }),
  } })).then((result) => result.QueueUrl!);
  return { queueUrl, dlqUrl };
}

async function awaitQueueArn(queueUrl: string): Promise<string> {
  const result = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }));
  return result.Attributes?.QueueArn ?? '';
}

async function signedUpload(filename: string, content: string): Promise<string> {
  const authorization = await request(app.getHttpServer())
    .post('/uploads/presign')
    .send({ filename, contentType: 'application/pdf', sizeBytes: Buffer.byteLength(content) })
    .expect(201);
  const key = authorization.body.fields.key as string;
  uploadedKeys.push(key);
  const body = new FormData();
  for (const [name, value] of Object.entries(authorization.body.fields as Record<string, string>)) body.append(name, value);
  body.append('file', new Blob([content], { type: 'application/pdf' }), filename);
  const response = await fetch(authorization.body.url as string, { method: 'POST', body });
  expect(response.status).toBe(204);
  return key;
}

async function simulate(key: string, outcome = 'clean', versionId?: string): Promise<void> {
  const args = ['run', 'simulate:scan', '--', key, outcome, ...(versionId ? ['--version-id', versionId] : [])];
  const childEnv = {
    ...process.env,
    S3_ENDPOINT_URL: endpoint,
    SQS_ENDPOINT_URL: process.env.SQS_ENDPOINT_URL ?? endpoint,
    S3_QUARANTINE_BUCKET: quarantineBucket,
    SQS_QUEUE_URL: testQueue.queueUrl,
  };
  await execFileAsync('npm', args, { cwd: process.cwd(), env: childEnv });
}

async function withWorker(queueUrl: string, assertion: () => Promise<void>): Promise<void> {
  process.env.SQS_QUEUE_URL = queueUrl;
  const context = await Test.createTestingModule({ imports: [ScanWorkerModule] }).compile();
  const worker = context.get(ScanWorkerService);
  const running = worker.run();
  try {
    await assertion();
  } finally {
    await worker.stop();
    await running;
    await context.close();
    process.env.SQS_QUEUE_URL = testQueue.queueUrl;
  }
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Condition did not become true within ${timeoutMs}ms`);
}

function scanEvent(key: string, versionId: string, eTag: string): string {
  return JSON.stringify({
    version: '0',
    id: randomUUID(),
    'detail-type': 'GuardDuty Malware Protection Object Scan Result',
    source: 'aws.guardduty',
    account: '000000000000',
    time: new Date().toISOString(),
    region,
    resources: [],
    detail: {
      schemaVersion: '1.0',
      scanStatus: 'COMPLETED',
      resourceType: 'S3_OBJECT',
      s3ObjectDetails: { bucketName: quarantineBucket, objectKey: key, versionId, eTag },
      scanResultDetails: { scanResultStatus: 'NO_THREATS_FOUND' },
    },
  });
}

function cleanKey(key: string, versionId: string): string {
  const uploadId = key.slice('incoming/'.length, -'.pdf'.length);
  const digest = createHash('sha256').update(versionId).digest('hex');
  return `cleared/${uploadId}/${digest}.pdf`;
}

async function promotedBody(key: string, versionId: string): Promise<string | undefined> {
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: s3Bucket, Key: cleanKey(key, versionId) }));
    return await response.Body?.transformToString();
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function sourceBody(key: string, versionId: string): Promise<string> {
  const response = await s3.send(new GetObjectCommand({ Bucket: quarantineBucket, Key: key, VersionId: versionId }));
  return (await response.Body?.transformToString()) ?? '';
}

async function cleanObjectsForUpload(key: string): Promise<string[]> {
  const uploadId = key.slice('incoming/'.length, -'.pdf'.length);
  const result = await s3.send(new ListObjectVersionsCommand({ Bucket: s3Bucket, Prefix: `cleared/${uploadId}/` }));
  return [...(result.Versions ?? []).map((version) => version.Key ?? ''), ...(result.DeleteMarkers ?? []).map((version) => version.Key ?? '')];
}

async function queueCounts(queueUrl: string): Promise<{ visible: number; inFlight: number }> {
  const response = await sqs.send(new GetQueueAttributesCommand({
    QueueUrl: queueUrl,
    AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
  }));
  return {
    visible: Number(response.Attributes?.ApproximateNumberOfMessages ?? 0),
    inFlight: Number(response.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
  };
}

async function receiveAvailable(queueUrl: string): Promise<Message[]> {
  const response = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, WaitTimeSeconds: 0, MaxNumberOfMessages: 10 }));
  return response.Messages ?? [];
}

async function deleteVersions(bucket: string, key: string): Promise<void> {
  const versions = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key }));
  const matches = [
    ...(versions.Versions ?? []).filter((version) => version.Key === key),
    ...(versions.DeleteMarkers ?? []).filter((version) => version.Key === key),
  ];
  for (const version of matches) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: version.VersionId }));
  }
}

async function deleteUploadArtifacts(key: string): Promise<void> {
  await deleteVersions(quarantineBucket, key);
  const uploadId = key.slice('incoming/'.length, -'.pdf'.length);
  const cleanVersions = await s3.send(new ListObjectVersionsCommand({ Bucket: s3Bucket, Prefix: `cleared/${uploadId}/` }));
  const keys = new Set([
    ...(cleanVersions.Versions ?? []).map((version) => version.Key).filter((value): value is string => Boolean(value)),
    ...(cleanVersions.DeleteMarkers ?? []).map((version) => version.Key).filter((value): value is string => Boolean(value)),
  ]);
  for (const cleanKey of keys) await deleteVersions(s3Bucket, cleanKey);
}
