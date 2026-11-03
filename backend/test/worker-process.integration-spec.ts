import { CreateQueueCommand, DeleteQueueCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { JobsStorageService } from '../src/jobs/jobs-storage.service.js';
import { runMigrations } from '../src/jobs/migrations.js';

const databaseUrl = process.env.TEST_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('Worker process integration requires a non-empty TEST_DATABASE_URL or DATABASE_URL');
const awsEndpoint = process.env.S3_ENDPOINT_URL ?? process.env.SQS_ENDPOINT_URL ?? 'http://localhost:4566';
const credentials = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
  ...(process.env.AWS_SESSION_TOKEN ? { sessionToken: process.env.AWS_SESSION_TOKEN } : {}),
};
const bucket = process.env.S3_QUARANTINE_BUCKET ?? 'doc-ai-local-quarantine';

describe('compiled worker process', () => {
  const suffix = randomUUID().replaceAll('-', '');
  const schema = `worker_process_${suffix}`;
  const uploadId = randomUUID();
  const key = `incoming/${uploadId}.pdf`;
  const queueName = `worker-main-${suffix.slice(0, 20)}`;
  const dlqName = `worker-dlq-${suffix.slice(0, 20)}`;
  const adminPool = new Pool({ connectionString: databaseUrl });
  const isolatedUrl = new URL(databaseUrl);
  isolatedUrl.searchParams.set('options', `-c search_path=${schema}`);
  const pool = new Pool({ connectionString: isolatedUrl.toString() });
  const jobs = new JobsStorageService(pool);
  const sqs = new SQSClient({ region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1', endpoint: process.env.SQS_ENDPOINT_URL ?? awsEndpoint, credentials });
  const s3 = new S3Client({ region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1', endpoint: process.env.S3_ENDPOINT_URL ?? awsEndpoint, forcePathStyle: true, credentials });
  let queueUrl: string | undefined;
  let dlqUrl: string | undefined;
  let child: ChildProcess | undefined;
  let childExit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;

  beforeAll(async () => {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    await runMigrations(pool);
    queueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: queueName, Attributes: { ReceiveMessageWaitTimeSeconds: '20', VisibilityTimeout: '120' } }))).QueueUrl;
    dlqUrl = (await sqs.send(new CreateQueueCommand({ QueueName: dlqName }))).QueueUrl;
    if (!queueUrl || !dlqUrl) throw new Error('Floci did not return worker queue URLs');
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: 'worker process source bytes' }));
    const head = await s3.send(new (await import('@aws-sdk/client-s3')).HeadObjectCommand({ Bucket: bucket, Key: key }));
    await jobs.createJob({ uploadId, bucket, key, etag: head.ETag!, sizeBytes: Buffer.byteLength('worker process source bytes') });

    child = spawn(process.execPath, ['dist/worker.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: isolatedUrl.toString(),
        S3_QUARANTINE_BUCKET: bucket,
        S3_ENDPOINT_URL: process.env.S3_ENDPOINT_URL ?? awsEndpoint,
        SQS_ENDPOINT_URL: process.env.SQS_ENDPOINT_URL ?? awsEndpoint,
        SQS_QUEUE_URL: queueUrl,
        SQS_DLQ_URL: dlqUrl,
        AWS_ACCESS_KEY_ID: credentials.accessKeyId,
        AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
        WORKER_POLL_WAIT_SECONDS: '20',
        WORKER_HEARTBEAT_MS: '30000',
        WORKER_LEASE_MS: '120000',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    childExit = new Promise((resolve) => child!.once('exit', (code, signal) => resolve({ code, signal })));
  }, 30_000);

  afterAll(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([childExit, delay(5000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => {});
    if (queueUrl) await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    if (dlqUrl) await sqs.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
    await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
    await Promise.all([adminPool.end(), pool.end()]);
    s3.destroy();
    sqs.destroy();
  });

  it('dispatches an isolated source job, marks it source_checked, and stops promptly on SIGTERM', async () => {
    const deadline = Date.now() + 15_000;
    let status = await jobs.getJobStatus(uploadId);
    while (status?.status !== 'source_checked' && Date.now() < deadline) {
      await delay(100);
      status = await jobs.getJobStatus(uploadId);
    }
    expect(status?.status).toBe('source_checked');
    expect(child?.exitCode).toBeNull();

    child!.kill('SIGTERM');
    const exited = await Promise.race([childExit!, delay(5000).then(() => undefined)]);
    expect(exited).toBeDefined();
    expect(exited?.code).toBe(0);
  }, 25_000);
});
