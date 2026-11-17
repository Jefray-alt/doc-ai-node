import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DATABASE_POOL, DatabaseModule } from '../database/database.module.ts';
import { JobsModule } from './jobs.module.ts';
import { JobsRepository } from './jobs.repository.ts';
import { JobsReconciler } from './jobs.reconciler.ts';

describe('JobsRepository dependency injection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves as a class provider and queries the injected database pool', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const moduleRef = await Test.createTestingModule({
      providers: [JobsRepository, { provide: DATABASE_POOL, useValue: pool }],
    })
      .compile();

    const repository = moduleRef.get(JobsRepository);
    await expect(repository.findByUploadId('upload-1')).resolves.toBeNull();
    expect(pool.query).toHaveBeenCalledWith(
      'SELECT * FROM jobs WHERE upload_id = $1',
      ['upload-1'],
    );

    await moduleRef.close();
  });

  it('atomically claims one due upload and maps its ownership', async () => {
    const row = {
      upload_id: 'f73d16da-c995-451c-849b-6401a5c89157',
      bucket: 'pdfs',
      object_key: 'incoming/oldest.pdf',
      status: 'awaiting_upload',
      claim_token: '599e095b-b4ab-48a7-aacd-4571eebacbd4',
      lease_expires_at: new Date('2026-01-01T00:02:00.000Z'),
      page_count: null,
      error_code: null,
      upload_expires_at: new Date('2026-01-01T00:00:00.000Z'),
      next_check_at: new Date('2026-01-01T00:00:00.000Z'),
      created_at: new Date('2025-12-31T23:59:00.000Z'),
      updated_at: new Date('2025-12-31T23:59:00.000Z'),
    };
    const pool = { query: vi.fn().mockResolvedValue({ rows: [row] }) };
    const repository = new JobsRepository(pool as never);

    await expect(repository.claimNextDueAwaitingUpload()).resolves.toMatchObject({
      uploadId: row.upload_id,
      objectKey: row.object_key,
      claimToken: row.claim_token,
      leaseExpiresAt: row.lease_expires_at,
      pageCount: null,
      errorCode: null,
    });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('FOR UPDATE SKIP LOCKED'),
      ['awaiting_upload', expect.any(String), 120_000],
    );
    expect(pool.query.mock.calls[0]?.[0]).toContain('ORDER BY next_check_at, created_at, upload_id');
  });

  it.each([
    { status: 'extracted', page_count: 7, error_code: null },
    { status: 'failed', page_count: null, error_code: 'INVALID_PDF' },
    { status: 'uploaded', page_count: null, error_code: 'S3_UNAVAILABLE' },
  ])('maps persisted extraction fields for $status jobs', async (outcome) => {
    const row = {
      upload_id: 'upload-1',
      bucket: 'pdfs',
      object_key: 'incoming/document.pdf',
      claim_token: null,
      lease_expires_at: null,
      upload_expires_at: new Date(),
      next_check_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
      ...outcome,
    };
    const pool = { query: vi.fn().mockResolvedValue({ rows: [row] }) };
    const repository = new JobsRepository(pool as never);

    await expect(repository.findByUploadId(row.upload_id)).resolves.toMatchObject({
      status: outcome.status,
      pageCount: outcome.page_count,
      errorCode: outcome.error_code,
    });
  });

  it('exports the repository without starting reconciliation', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule, JobsModule],
    })
      .overrideProvider(DATABASE_POOL)
      .useValue(pool)
      .compile();

    expect(moduleRef.get(JobsRepository)).toBeInstanceOf(JobsRepository);
    expect(() => moduleRef.get(JobsReconciler, { strict: false })).toThrow();

    await moduleRef.close();
  });
});
