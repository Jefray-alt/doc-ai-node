import { Test } from '@nestjs/testing';
import { DeleteObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module.js';
import { getDatabasePool } from '../src/database/database.pool.js';
import { JobsRepository } from '../src/jobs/jobs.repository.js';
import { JobsReconciler } from '../src/jobs/jobs.reconciler.js';

class ManualJobsReconciler extends JobsReconciler {
  override onModuleInit(): void {}
}

const quarantineBucket = 'doc-ai-local-quarantine';
const ingestionBucket = 'doc-ai-local-pdfs';

process.env.AWS_ACCESS_KEY_ID = 'test';
process.env.AWS_SECRET_ACCESS_KEY = 'test';
process.env.AWS_DEFAULT_REGION = 'us-east-1';
process.env.S3_ENDPOINT_URL = 'http://localhost:4566';
process.env.S3_QUARANTINE_BUCKET = quarantineBucket;

describe('Quarantine upload against Floci', () => {
  let app: INestApplication;
  let reconciler: ManualJobsReconciler;
  const s3 = new S3Client({
    region: 'us-east-1',
    endpoint: 'http://localhost:4566',
    forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });

  beforeAll(async () => {
    reconciler = new ManualJobsReconciler(new JobsRepository(getDatabasePool()), s3);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JobsReconciler)
      .useValue(reconciler)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await reconciler.onModuleDestroy();
    await app.close();
    s3.destroy();
  });

  it('accepts the signed browser POST into quarantine only', async () => {
    const missingAuthorization = await request(app.getHttpServer())
      .post('/uploads/presign')
      .send({ filename: 'missing.pdf', contentType: 'application/pdf', sizeBytes: 24 })
      .expect(201);
    const missingUploadId = missingAuthorization.body.uploadId as string;
    const missingRow = await getDatabasePool().query<{ status: string }>(
      'SELECT status FROM jobs WHERE upload_id = $1',
      [missingUploadId],
    );
    expect(missingRow.rows[0]?.status).toBe('awaiting_upload');

    const authorization = await request(app.getHttpServer())
      .post('/uploads/presign')
      .send({ filename: 'integration.pdf', contentType: 'application/pdf', sizeBytes: 24 })
      .expect(201);
    const key = authorization.body.fields.key as string;
    const body = new FormData();
    for (const [name, value] of Object.entries(authorization.body.fields as Record<string, string>)) {
      body.append(name, value);
    }
    body.append('file', new Blob(['%PDF-1.7 Floci integration'], { type: 'application/pdf' }), 'integration.pdf');

    try {
      const response = await fetch(authorization.body.url as string, { method: 'POST', body });
      expect(response.status).toBe(204);

      await expect(s3.send(new HeadObjectCommand({ Bucket: quarantineBucket, Key: key })))
        .resolves.toMatchObject({ $metadata: { httpStatusCode: 200 } });

      const ingestionLookup = await s3
        .send(new HeadObjectCommand({ Bucket: ingestionBucket, Key: key }))
        .then(() => null, (error: unknown) => error);
      expect(ingestionLookup).toMatchObject({ $metadata: { httpStatusCode: 404 } });

      await reconciler.onModuleDestroy();
      reconciler = new ManualJobsReconciler(new JobsRepository(getDatabasePool()), s3);
      await reconciler.reconcileOnce();
      const reconciled = await getDatabasePool().query<{ status: string }>(
        'SELECT status FROM jobs WHERE upload_id = $1',
        [authorization.body.uploadId],
      );
      expect(reconciled.rows[0]?.status).toBe('pending_dispatch');

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
        { status: 'pending_dispatch', count: '1' },
      ]);
    } finally {
      await s3.send(new DeleteObjectCommand({ Bucket: quarantineBucket, Key: key }));
    }
  });
});
