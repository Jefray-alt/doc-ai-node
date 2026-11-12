import { Test } from '@nestjs/testing';
import { DeleteObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { AppModule } from '../src/app.module.js';
import { getDatabasePool } from '../src/database/database.pool.js';
import { JobsReconciler } from '../src/jobs/jobs.reconciler.js';
import { WorkerModule } from '../src/worker.module.js';

const pdfBucket = 'doc-ai-local-pdfs';

process.env.AWS_ACCESS_KEY_ID = 'test';
process.env.AWS_SECRET_ACCESS_KEY = 'test';
process.env.AWS_DEFAULT_REGION = 'us-east-1';
process.env.S3_ENDPOINT_URL = 'http://localhost:4566';
process.env.S3_BUCKET_NAME = pdfBucket;

describe('PDF upload against Floci', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  const s3 = new S3Client({
    region: 'us-east-1',
    endpoint: 'http://localhost:4566',
    forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const workerRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    worker = workerRef;
    await worker.init();
  });

  afterAll(async () => {
    await app.close();
    await worker.close();
    s3.destroy();
  });

  it('stores the signed browser POST in the bucket recorded on its job', async () => {
    const missingAuthorization = await request(app.getHttpServer())
      .post('/uploads/presign')
      .send({ filename: 'missing.pdf', contentType: 'application/pdf', sizeBytes: 24 })
      .expect(201);
    const missingUploadId = missingAuthorization.body.uploadId as string;
    let uploadedId: string | undefined;
    const missingRow = await getDatabasePool().query<{ status: string; bucket: string }>(
      'SELECT status, bucket FROM jobs WHERE upload_id = $1',
      [missingUploadId],
    );
    expect(missingRow.rows[0]).toEqual({ status: 'awaiting_upload', bucket: pdfBucket });

    const authorization = await request(app.getHttpServer())
      .post('/uploads/presign')
      .send({ filename: 'integration.pdf', contentType: 'application/pdf', sizeBytes: 24 })
      .expect(201);
    uploadedId = authorization.body.uploadId as string;
    const key = authorization.body.fields.key as string;
    const body = new FormData();
    for (const [name, value] of Object.entries(authorization.body.fields as Record<string, string>)) {
      body.append(name, value);
    }
    body.append('file', new Blob(['%PDF-1.7 Floci integration'], { type: 'application/pdf' }), 'integration.pdf');

    try {
      const response = await fetch(authorization.body.url as string, { method: 'POST', body });
      expect(response.status).toBe(204);

      await expect(s3.send(new HeadObjectCommand({ Bucket: pdfBucket, Key: key })))
        .resolves.toMatchObject({ $metadata: { httpStatusCode: 200 } });

      const uploadedRow = await getDatabasePool().query<{ bucket: string; object_key: string }>(
        'SELECT bucket, object_key FROM jobs WHERE upload_id = $1',
        [authorization.body.uploadId],
      );
      expect(uploadedRow.rows[0]).toEqual({ bucket: pdfBucket, object_key: key });

      await worker.get(JobsReconciler).reconcileOnce();
      await worker.get(JobsReconciler).reconcileOnce();
      const reconciled = await getDatabasePool().query<{ status: string; bucket: string }>(
        'SELECT status, bucket FROM jobs WHERE upload_id = $1',
        [authorization.body.uploadId],
      );
      expect(reconciled.rows[0]).toEqual({ status: 'uploaded', bucket: pdfBucket });

      const retainedMissing = await getDatabasePool().query<{ status: string }>(
        'SELECT status FROM jobs WHERE upload_id = $1',
        [missingUploadId],
      );
      expect(retainedMissing.rows[0]?.status).toBe('awaiting_upload');

      const relevantStatuses = await getDatabasePool().query<{ status: string; count: string }>(
        `SELECT status, count(*)::text AS count FROM jobs
         WHERE upload_id = ANY($1::uuid[]) GROUP BY status ORDER BY status`,
        [[missingUploadId, authorization.body.uploadId]],
      );
      expect(relevantStatuses.rows).toEqual([
        { status: 'awaiting_upload', count: '1' },
        { status: 'uploaded', count: '1' },
      ]);
    } finally {
      await s3.send(new DeleteObjectCommand({ Bucket: pdfBucket, Key: key }));
      await getDatabasePool().query(
        'DELETE FROM jobs WHERE upload_id = ANY($1::uuid[])',
        [[missingUploadId, uploadedId]],
      );
    }
  });
});
