import { CreateQueueCommand, DeleteQueueCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobsStorageService } from '../src/jobs/jobs-storage.service.js';
import { runMigrations } from '../src/jobs/migrations.js';
import { OutboxPublisherService } from '../src/jobs/outbox-publisher.service.js';
import { UploadsModule } from '../src/uploads/uploads.module.js';

const databaseUrl = process.env.TEST_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('Floci integration tests require a non-empty TEST_DATABASE_URL or DATABASE_URL');
const integration = describe;
const bucket = process.env.S3_QUARANTINE_BUCKET ?? 'doc-ai-local-quarantine';
const awsEndpoint = process.env.S3_ENDPOINT_URL ?? 'http://localhost:4566';
const sqsEndpoint = process.env.SQS_ENDPOINT_URL ?? awsEndpoint;
const credentials = { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test' };

integration('upload completion dispatches an isolated job through S3, PostgreSQL, and SQS', () => {
  const schema = `upload_job_test_${randomUUID().replaceAll('-', '')}`;
  const adminPool = new Pool({ connectionString: databaseUrl });
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  const jobs = new JobsStorageService(pool);
  const s3 = new S3Client({ region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1', endpoint: awsEndpoint, forcePathStyle: true, credentials });
  const sqs = new SQSClient({ region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1', endpoint: sqsEndpoint, credentials });
  const queueName = `upload-complete-${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  let queueUrl: string | undefined;
  let app: INestApplication | undefined;

  beforeAll(async () => {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    await runMigrations(pool);
    const queue = await sqs.send(new CreateQueueCommand({ QueueName: queueName }));
    queueUrl = queue.QueueUrl;
    if (!queueUrl) throw new Error('Floci did not return a queue URL');

    const moduleRef = await Test.createTestingModule({ imports: [UploadsModule] })
      .overrideProvider(JobsStorageService)
      .useValue(jobs)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (queueUrl) await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
    await adminPool.end();
    await s3.destroy();
    await sqs.destroy();
  });

  it('stores actual HEAD metadata, enqueues only the upload reference, and keeps completion idempotent', async () => {
    const uploadId = randomUUID();
    const key = `incoming/${uploadId}.pdf`;
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: '%PDF-1.7 T2 integration', ContentType: 'application/pdf' }));

    try {
      const [completion, concurrentCompletion] = await Promise.all([
        request(app!.getHttpServer()).post(`/uploads/${uploadId}/complete`).expect(202),
        request(app!.getHttpServer()).post(`/uploads/${uploadId}/complete`).expect(202),
      ]);
      expect(completion.body).toMatchObject({ uploadId, status: 'queued', error: null, updatedAt: expect.any(String) });
      expect(concurrentCompletion.body).toEqual(completion.body);

      const stored = await jobs.getJobStatus(uploadId);
      expect(stored).toMatchObject({ uploadId, bucket, key, status: 'queued', sizeBytes: Buffer.byteLength('%PDF-1.7 T2 integration') });
      expect(stored?.etag).toBeTruthy();
      const beforeRepeat = await pool.query('SELECT count(*)::int AS count FROM job_outbox WHERE upload_id = $1', [uploadId]);

      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      await request(app!.getHttpServer()).post(`/uploads/${uploadId}/complete`).expect(202, completion.body);
      const afterRepeat = await pool.query('SELECT count(*)::int AS count FROM job_outbox WHERE upload_id = $1', [uploadId]);
      expect(beforeRepeat.rows[0].count).toBe(1);
      expect(afterRepeat.rows[0].count).toBe(1);

      const publisher = new OutboxPublisherService(jobs, sqs, { queueUrl: queueUrl!, batchSize: 1, leaseMs: 30_000 });
      await expect(publisher.dispatchOnce()).resolves.toMatchObject({ claimed: 1, sent: 1, released: 0 });
      const received = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 0 }));
      expect(received.Messages).toHaveLength(1);
      expect(JSON.parse(received.Messages![0].Body!)).toEqual({ uploadId, payloadVersion: 1 });

      const status = await request(app!.getHttpServer()).get(`/uploads/${uploadId}/status`).expect(200);
      expect(status.body).toEqual(completion.body);
    } finally {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    }
  });
});
