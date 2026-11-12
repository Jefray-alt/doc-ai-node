import { S3Client } from '@aws-sdk/client-s3';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module.js';
import { getDatabasePool } from '../src/database/database.pool.js';
import { JobsReconciler } from '../src/jobs/jobs.reconciler.js';
import { JobsRepository } from '../src/jobs/jobs.repository.js';
import { WorkerModule } from '../src/worker.module.js';

describe('API and worker module boundaries', () => {
  let api: INestApplication;
  const s3 = { send: async () => ({}), destroy: vi.fn() };

  beforeAll(async () => {
    const apiRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JobsRepository)
      .useValue({ create: async () => ({}) })
      .compile();
    api = apiRef.createNestApplication();
    await api.init();
  });

  afterAll(async () => {
    await api.close();
  });

  it('does not construct a reconciler in the API process', () => {
    expect(() => api.get(JobsReconciler, { strict: false })).toThrow();
  });

  it('starts a standalone context and closes its S3 client during shutdown', async () => {
    const databasePool = getDatabasePool();
    const endPool = vi.spyOn(databasePool, 'end');
    const worker = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(JobsRepository)
      .useValue({ findNextDueAwaitingUpload: async () => null })
      .overrideProvider(S3Client)
      .useValue(s3)
      .compile();
    await worker.init();

    expect(worker.get(JobsReconciler)).toBeInstanceOf(JobsReconciler);
    expect('listen' in worker).toBe(false);

    await worker.close();

    expect(s3.destroy).toHaveBeenCalledOnce();
    expect(endPool).toHaveBeenCalledOnce();
  });
});
