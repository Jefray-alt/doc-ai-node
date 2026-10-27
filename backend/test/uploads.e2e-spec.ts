import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module.js';

process.env.AWS_ACCESS_KEY_ID = 'test';
process.env.AWS_SECRET_ACCESS_KEY = 'test';
process.env.AWS_DEFAULT_REGION = 'us-east-1';
process.env.S3_ENDPOINT_URL = 'http://localhost:4566';
process.env.S3_QUARANTINE_BUCKET = 'doc-ai-local-quarantine';

describe('PDF upload authorization', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns a short-lived PDF-only POST policy for a generated quarantine key', async () => {
    const response = await request(app.getHttpServer())
      .post('/uploads/presign')
      .send({ filename: 'quarterly report.pdf', contentType: 'application/pdf', sizeBytes: 1024 })
      .expect(201);

    expect(response.body).toMatchObject({
      uploadId: expect.any(String),
      url: 'http://localhost:4566/doc-ai-local-quarantine',
      fields: expect.objectContaining({
        key: expect.stringMatching(/^incoming\/[0-9a-f-]+\.pdf$/),
        'Content-Type': 'application/pdf',
        Policy: expect.any(String),
      }),
      expiresAt: expect.any(String),
    });
    expect(response.body.fields.key).toContain(response.body.uploadId);

    const policy = JSON.parse(Buffer.from(response.body.fields.Policy, 'base64').toString());
    expect(policy.conditions).toContainEqual(['eq', '$Content-Type', 'application/pdf']);
    expect(policy.conditions).toContainEqual(['content-length-range', 1, 20 * 1024 * 1024]);

    const expiry = Date.parse(response.body.expiresAt);
    expect(expiry).toBeGreaterThan(Date.now());
    expect(expiry).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000);
  });

  it.each([
    null,
    [{ filename: 'notes.txt', contentType: 'application/pdf', sizeBytes: 1 }],
    [{ filename: 'notes.pdf', contentType: 'text/plain', sizeBytes: 1 }],
    [{ filename: 'notes.pdf', contentType: 'application/pdf', sizeBytes: 0 }],
    [{ filename: 'notes.pdf', contentType: 'application/pdf', sizeBytes: 20 * 1024 * 1024 + 1 }],
  ])('rejects invalid upload metadata: %j', async (payload) => {
    await request(app.getHttpServer())
      .post('/uploads/presign')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(payload))
      .expect(400);
  });
});
