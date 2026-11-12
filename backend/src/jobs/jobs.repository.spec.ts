import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DATABASE_POOL, DatabaseModule } from '../database/database.module.js';
import { JobsModule } from './jobs.module.js';
import { JobsRepository } from './jobs.repository.js';
import { JobsReconciler } from './jobs.reconciler.js';

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

  it('queries only the oldest due upload and returns it as one job', async () => {
    const row = {
      upload_id: 'f73d16da-c995-451c-849b-6401a5c89157',
      bucket: 'pdfs',
      object_key: 'incoming/oldest.pdf',
      status: 'awaiting_upload',
      upload_expires_at: new Date('2026-01-01T00:00:00.000Z'),
      next_check_at: new Date('2026-01-01T00:00:00.000Z'),
      created_at: new Date('2025-12-31T23:59:00.000Z'),
      updated_at: new Date('2025-12-31T23:59:00.000Z'),
    };
    const pool = { query: vi.fn().mockResolvedValue({ rows: [row] }) };
    const repository = new JobsRepository(pool as never);
    const now = new Date('2026-01-01T00:00:00.000Z');

    await expect(repository.findNextDueAwaitingUpload(now)).resolves.toMatchObject({
      uploadId: row.upload_id,
      objectKey: row.object_key,
    });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('ORDER BY next_check_at, created_at'),
      [now],
    );
    expect(pool.query.mock.calls[0]?.[0]).toContain('LIMIT 1');
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
