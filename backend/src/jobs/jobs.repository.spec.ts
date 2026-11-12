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
