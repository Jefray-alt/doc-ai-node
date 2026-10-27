import { Test } from '@nestjs/testing';
import { DeleteObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module.js';

const quarantineBucket = 'doc-ai-local-quarantine';
const ingestionBucket = 'doc-ai-local-pdfs';

process.env.AWS_ACCESS_KEY_ID = 'test';
process.env.AWS_SECRET_ACCESS_KEY = 'test';
process.env.AWS_DEFAULT_REGION = 'us-east-1';
process.env.S3_ENDPOINT_URL = 'http://localhost:4566';
process.env.S3_QUARANTINE_BUCKET = quarantineBucket;

describe('Quarantine upload against Floci', () => {
  let app: INestApplication;
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
  });

  afterAll(async () => {
    await app.close();
    s3.destroy();
  });

  it('accepts the signed browser POST into quarantine only', async () => {
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
    } finally {
      await s3.send(new DeleteObjectCommand({ Bucket: quarantineBucket, Key: key }));
    }
  });
});
