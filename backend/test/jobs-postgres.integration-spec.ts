import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { closeDatabasePool, getDatabasePool } from '../src/database/database.pool.js';
import { migrateDatabase } from '../src/database/migrations/migrate.js';
import { JobsRepository } from '../src/jobs/jobs.repository.js';
import type { JobStatus } from '../src/jobs/jobs.repository.js';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for the PostgreSQL integration suite');
}

describe('PostgreSQL upload jobs', () => {
  const adminPool = new Pool({ connectionString: databaseUrl, query_timeout: 5_000 });
  const repository = new JobsRepository(getDatabasePool());

  async function createJob(status: JobStatus, nextCheckAt: Date, createdAt?: Date) {
    const uploadId = randomUUID();
    const job = await repository.create({
      uploadId,
      bucket: 'integration-pdfs',
      objectKey: `integration/${uploadId}.pdf`,
      status,
      uploadExpiresAt: new Date(nextCheckAt.getTime() + 60_000),
      nextCheckAt,
    });

    if (createdAt) {
      await adminPool.query('UPDATE jobs SET created_at = $2 WHERE upload_id = $1', [uploadId, createdAt]);
    }

    return job;
  }

  afterEach(async () => {
    await adminPool.query('DELETE FROM jobs');
  });

  afterAll(async () => {
    await closeDatabasePool();
    await adminPool.end();
  });

  it('applies tracked migrations once and leaves the schema repeat-safe', async () => {
    const firstRun = await migrateDatabase();
    const secondRun = await migrateDatabase();
    const migrationCount = await adminPool.query<{ count: string }>(
      'SELECT count(*) FROM schema_migrations',
    );
    const appliedCount = Number(migrationCount.rows[0]?.count);

    expect(firstRun.applied.length).toBeGreaterThan(0);
    expect(secondRun.applied).toEqual([]);
    expect(appliedCount).toBe(firstRun.applied.length);
  });

  it('persists a job and enforces its key, status, and expiry constraints', async () => {
    const uploadId = randomUUID();
    const objectKey = `integration/${uploadId}.pdf`;
    const created = await repository.create({
      uploadId,
      bucket: 'integration-pdfs',
      objectKey,
      status: 'awaiting_upload',
      uploadExpiresAt: new Date(Date.now() + 60_000),
      nextCheckAt: new Date(),
    });

    expect(created.uploadId).toBe(uploadId);
    expect(created.status).toBe('awaiting_upload');
    expect(created.pageCount).toBeNull();
    expect(created.errorCode).toBeNull();
    expect(created.claimToken).toBeNull();
    expect(created.leaseExpiresAt).toBeNull();

    const persisted = await repository.findByUploadId(uploadId);
    expect(persisted).toMatchObject({
      uploadId,
      bucket: 'integration-pdfs',
      objectKey,
      status: 'awaiting_upload',
    });

    await expect(
      adminPool.query(
        `INSERT INTO jobs
          (upload_id, bucket, object_key, status, upload_expires_at, next_check_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          randomUUID(),
          'integration-pdfs',
          objectKey,
          'awaiting_upload',
          new Date(Date.now() + 60_000),
          new Date(),
        ],
      ),
    ).rejects.toMatchObject({ code: '23505' });

    await expect(
      adminPool.query(
        `INSERT INTO jobs
          (upload_id, bucket, object_key, status, upload_expires_at, next_check_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          randomUUID(),
          'integration-pdfs',
          objectKey,
          'invalid',
          new Date(Date.now() + 60_000),
          new Date(),
        ],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    await expect(
      adminPool.query(
        `INSERT INTO jobs
          (upload_id, bucket, object_key, status, upload_expires_at, next_check_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          'f73d16da-c995-451c-849b-6401a5c89157',
          'integration-pdfs',
          'integration/expired.pdf',
          'awaiting_upload',
          null,
          new Date(),
        ],
      ),
    ).rejects.toMatchObject({ code: '23502' });
  });

  it('persists operational retries and clears their error after successful extraction', async () => {
    const now = new Date(Date.now() - 1_000);
    const job = await createJob('uploaded', now);
    const retryAt = new Date(Date.now() + 60_000);
    const claim = (await repository.claimNextDueUploaded())!;

    expect(await repository.retryExtraction(job.uploadId, claim.claimToken, 'S3_UNAVAILABLE', retryAt)).toBe(true);
    await expect(repository.findByUploadId(job.uploadId)).resolves.toMatchObject({
      status: 'uploaded', pageCount: null, errorCode: 'S3_UNAVAILABLE', nextCheckAt: retryAt,
    });
    await expect(repository.claimNextDueUploaded()).resolves.toBeNull();
    await adminPool.query('UPDATE jobs SET next_check_at = now() WHERE upload_id = $1', [job.uploadId]);
    const reclaimed = (await repository.claimNextDueUploaded())!;

    expect(await repository.completeExtraction(job.uploadId, reclaimed.claimToken, 3)).toBe(true);
    await expect(repository.findByUploadId(job.uploadId)).resolves.toMatchObject({
      status: 'extracted', pageCount: 3, errorCode: null,
    });
  });

  it('retains terminal failure codes without a page count', async () => {
    const job = await createJob('uploaded', new Date());
    const claim = (await repository.claimNextDueUploaded())!;

    expect(await repository.failExtraction(job.uploadId, claim.claimToken, 'INVALID_PDF')).toBe(true);
    await expect(repository.findByUploadId(job.uploadId)).resolves.toMatchObject({
      status: 'failed', pageCount: null, errorCode: 'INVALID_PDF',
    });
  });

  it('requires positive physical page counts on extracted jobs only', async () => {
    const job = await createJob('uploaded', new Date());

    const claim = (await repository.claimNextDueUploaded())!;
    for (const pageCount of [0, -1]) {
      await expect(repository.completeExtraction(job.uploadId, claim.claimToken, pageCount)).rejects.toMatchObject({ code: '23514' });
    }
    await expect(adminPool.query(
      "UPDATE jobs SET status = 'extracted' WHERE upload_id = $1", [job.uploadId],
    )).rejects.toMatchObject({ code: '23514' });
    await expect(adminPool.query(
      'UPDATE jobs SET page_count = 1 WHERE upload_id = $1', [job.uploadId],
    )).rejects.toMatchObject({ code: '23514' });
    await expect(repository.findByUploadId(job.uploadId)).resolves.toMatchObject({
      status: 'uploaded', pageCount: null,
    });
  });

  const workStatuses = ['awaiting_upload', 'uploaded'] as const;
  type WorkStatus = typeof workStatuses[number];
  const claimNext = (repo: JobsRepository, status: WorkStatus) => status === 'uploaded'
    ? repo.claimNextDueUploaded() : repo.claimNextDueAwaitingUpload();
  const dueAt = () => new Date(Date.now() - 10_000);
  const expireClaim = (uploadId: string) => adminPool.query(
    "UPDATE jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE upload_id = $1", [uploadId],
  );

  async function withConnections(run: (left: JobsRepository, right: JobsRepository, lock: () => Promise<void>) => Promise<void>) {
    const left = await adminPool.connect();
    const right = await adminPool.connect();
    try {
      expect((await left.query('SELECT pg_backend_pid()')).rows[0]).not.toEqual(
        (await right.query('SELECT pg_backend_pid()')).rows[0],
      );
      await run(new JobsRepository(left as never), new JobsRepository(right as never), async () => {
        await left.query('BEGIN');
        await left.query('SELECT * FROM jobs ORDER BY next_check_at, created_at, upload_id LIMIT 1 FOR UPDATE');
      });
    } finally {
      await left.query('ROLLBACK');
      left.release();
      right.release();
    }
  }

  it.each(workStatuses)('allows only one owner competing for one %s row on separate connections', async (status) => {
    const job = await createJob(status, dueAt());
    await withConnections(async (left, right) => {
      const claims = await Promise.all([claimNext(left, status), claimNext(right, status)]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(claims.find(Boolean)).toMatchObject({ uploadId: job.uploadId, claimToken: expect.any(String) });
      const persisted = (await repository.findByUploadId(job.uploadId))!;
      expect(persisted.claimToken).toBe(claims.find(Boolean)!.claimToken);
      const { rows } = await adminPool.query(
        'SELECT extract(epoch FROM (lease_expires_at - clock_timestamp())) AS seconds FROM jobs',
      );
      expect(Number(rows[0].seconds)).toBeGreaterThan(115);
      expect(Number(rows[0].seconds)).toBeLessThanOrEqual(120);
    });
  });

  it.each(workStatuses)('claims distinct %s jobs concurrently and skips locked rows', async (status) => {
    const first = await createJob(status, new Date(Date.now() - 20_000));
    const second = await createJob(status, dueAt());
    await withConnections(async (_left, right, lock) => {
      await lock();
      const skipped = (await claimNext(right, status))!;
      expect(skipped.uploadId).toBe(second.uploadId);
      await repository.releaseClaim(skipped.uploadId, skipped.claimToken, status);
    });
    await withConnections(async (left, right) => {
      const claims = await Promise.all([claimNext(left, status), claimNext(right, status)]);
      expect(claims.map((claim) => claim!.uploadId).sort()).toEqual([first.uploadId, second.uploadId].sort());
      expect(new Set(claims.map((claim) => claim!.claimToken)).size).toBe(2);
    });
  });

  it.each(workStatuses)('orders due %s work by schedule, creation, and upload ID, excluding future and live claims', async (status) => {
    await expect(claimNext(repository, status)).resolves.toBeNull();
    await createJob(status, new Date(Date.now() + 60_000));
    await createJob(status === 'uploaded' ? 'awaiting_upload' : 'uploaded', dueAt());
    await createJob('expired', dueAt());
    const schedule = dueAt();
    const created = new Date(schedule.getTime() - 10_000);
    const ties = [await createJob(status, schedule, created), await createJob(status, schedule, created)]
      .sort((a, b) => a.uploadId.localeCompare(b.uploadId));
    const laterCreated = await createJob(status, schedule, new Date(created.getTime() + 1));
    const laterDue = await createJob(status, new Date(schedule.getTime() + 1), new Date(created.getTime() - 1));
    for (const expected of [...ties, laterCreated, laterDue]) {
      await expect(claimNext(repository, status)).resolves.toMatchObject({ uploadId: expected.uploadId });
    }
    await expect(claimNext(repository, status)).resolves.toBeNull();
  });

  it.each(workStatuses)('reclaims expired %s ownership with a fresh token', async (status) => {
    const job = await createJob(status, dueAt());
    const first = (await claimNext(repository, status))!;
    await expect(claimNext(repository, status)).resolves.toBeNull();
    await expireClaim(job.uploadId);
    const second = (await claimNext(repository, status))!;
    expect(second.uploadId).toBe(job.uploadId);
    expect(second.claimToken).not.toBe(first.claimToken);
    expect(second.leaseExpiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  const retryAt = new Date('2099-01-01T00:00:00Z');
  const mutations = [
    {
      name: 'confirm', status: 'awaiting_upload',
      run: (id: string, token: string, repo = repository) => repo.confirmUpload(id, token),
      outcome: { status: 'uploaded' },
    },
    {
      name: 'expire', status: 'awaiting_upload',
      run: (id: string, token: string, repo = repository) => repo.expireMissingUpload(id, token),
      outcome: { status: 'expired' },
    },
    {
      name: 'retry upload', status: 'awaiting_upload',
      run: (id: string, token: string, repo = repository) => repo.retryUploadCheck(id, token, retryAt),
      outcome: { status: 'awaiting_upload', nextCheckAt: retryAt },
    },
    {
      name: 'complete', status: 'uploaded',
      run: (id: string, token: string, repo = repository) => repo.completeExtraction(id, token, 3),
      outcome: { status: 'extracted', pageCount: 3, errorCode: null },
    },
    {
      name: 'fail', status: 'uploaded',
      run: (id: string, token: string, repo = repository) => repo.failExtraction(id, token, 'PDF_MALFORMED'),
      outcome: { status: 'failed', errorCode: 'PDF_MALFORMED', pageCount: null },
    },
    {
      name: 'retry extraction', status: 'uploaded',
      run: (id: string, token: string, repo = repository) => repo.retryExtraction(id, token, 'PDF_PROCESSING_FAILED', retryAt),
      outcome: { status: 'uploaded', nextCheckAt: retryAt, errorCode: 'PDF_PROCESSING_FAILED' },
    },
    ...workStatuses.map((status) => ({
      name: `release ${status}`, status,
      run: (id: string, token: string, repo = repository) => repo.releaseClaim(id, token, status),
      outcome: { status },
    })),
  ] as const;

  it.each(mutations)('$name requires matching live ownership and expected status, and clears accepted ownership', async (mutation) => {
    for (const invalid of ['stale', 'expired', 'wrong-status', 'unclaimed', 'missing']) {
      const status = invalid === 'wrong-status'
        ? mutation.status === 'uploaded' ? 'awaiting_upload' : 'uploaded'
        : mutation.status;
      const job = await createJob(status, dueAt());
      const first = (await claimNext(repository, status))!;
      if (invalid === 'expired' || invalid === 'stale') await expireClaim(job.uploadId);
      if (invalid === 'stale') await claimNext(repository, status);
      if (invalid === 'unclaimed') await repository.releaseClaim(job.uploadId, first.claimToken, status);
      const uploadId = invalid === 'missing' ? randomUUID() : job.uploadId;
      const before = await repository.findByUploadId(job.uploadId);
      expect(await mutation.run(uploadId, first.claimToken), invalid).toBe(false);
      await expect(repository.findByUploadId(job.uploadId)).resolves.toEqual(before);
      await adminPool.query('DELETE FROM jobs WHERE upload_id = $1', [job.uploadId]);
    }
    const job = await createJob(mutation.status, dueAt());
    const claim = (await claimNext(repository, mutation.status))!;
    expect(await mutation.run(job.uploadId, claim.claimToken)).toBe(true);
    await expect(repository.findByUploadId(job.uploadId)).resolves.toMatchObject({
      ...mutation.outcome, claimToken: null, leaseExpiresAt: null,
    });
  });

  it.each(mutations)('$name rechecks live ownership after a row lock wait', async (mutation) => {
    const job = await createJob(mutation.status, dueAt());
    const claim = (await claimNext(repository, mutation.status))!;
    const holder = await adminPool.connect();
    const writer = await adminPool.connect();
    const writerPid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    let outcome: Promise<boolean> | undefined;
    try {
      await adminPool.query(
        "UPDATE jobs SET lease_expires_at = clock_timestamp() + interval '1 second' WHERE upload_id = $1",
        [job.uploadId],
      );
      const before = await repository.findByUploadId(job.uploadId);
      await holder.query('BEGIN');
      await holder.query('SELECT upload_id FROM jobs WHERE upload_id = $1 FOR UPDATE', [job.uploadId]);
      outcome = mutation.run(job.uploadId, claim.claimToken, new JobsRepository(writer as never));
      await expect.poll(async () => {
        const result = await adminPool.query(
          'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [writerPid],
        );
        return result.rows[0]?.wait_event_type;
      }).toBe('Lock');
      // Wait only for the explicitly shortened database lease, with the writer already blocked.
      // Do not update this row: that would force an EPQ recheck and hide the lock-only race.
      await holder.query(
        `SELECT pg_sleep(GREATEST(0, extract(epoch FROM (lease_expires_at - clock_timestamp()))) + 0.05)
         FROM jobs WHERE upload_id = $1`, [job.uploadId],
      );
      await holder.query('COMMIT');
      expect(await outcome).toBe(false);
      await expect(repository.findByUploadId(job.uploadId)).resolves.toEqual(before);
    } finally {
      await holder.query('ROLLBACK');
      await outcome?.catch(() => undefined);
      holder.release();
      writer.release();
    }
  });

  it('enforces paired ownership fields and forbids terminal claims', async () => {
    const job = await createJob('awaiting_upload', dueAt());
    for (const assignment of [
      `claim_token = '${randomUUID()}'`,
      "lease_expires_at = now() + interval '2 minutes'",
      `status = 'expired', claim_token = '${randomUUID()}', lease_expires_at = now() + interval '2 minutes'`,
    ]) {
      await expect(adminPool.query(`UPDATE jobs SET ${assignment} WHERE upload_id = $1`, [job.uploadId]))
        .rejects.toMatchObject({ code: '23514' });
    }
  });

  it('upgrades a persisted legacy pending_dispatch row without changing its identity or data', async () => {
    const schema = `jobs_migration_${randomUUID().replaceAll('-', '')}`;
    const scopedPool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
    });
    const uploadId = randomUUID();
    const objectKey = `legacy/${uploadId}.pdf`;
    const expiry = new Date('2026-01-01T00:00:00.000Z');
    const nextCheck = new Date('2025-12-31T23:59:00.000Z');

    try {
      await adminPool.query(`CREATE SCHEMA ${schema}`);
      const legacyMigration = await readFile(
        fileURLToPath(new URL('../src/database/migrations/sql/001_create_jobs.sql', import.meta.url)),
        'utf8',
      );
      await scopedPool.query(legacyMigration);
      await scopedPool.query(`
        CREATE TABLE schema_migrations (
          version text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await scopedPool.query(
        'INSERT INTO schema_migrations (version) VALUES ($1)',
        ['001_create_jobs.sql'],
      );
      await scopedPool.query(
        `INSERT INTO jobs
          (upload_id, bucket, object_key, status, upload_expires_at, next_check_at)
         VALUES ($1, $2, $3, 'pending_dispatch', $4, $5)`,
        [uploadId, 'legacy-pdfs', objectKey, expiry, nextCheck],
      );
      const firstUpgrade = await migrateDatabase(scopedPool);
      const repeatUpgrade = await migrateDatabase(scopedPool);
      const upgraded = await scopedPool.query(
        `SELECT upload_id, bucket, object_key, status, upload_expires_at, next_check_at, page_count, error_code, claim_token, lease_expires_at
         FROM jobs WHERE upload_id = $1`,
        [uploadId],
      );

      expect(firstUpgrade.applied).toEqual(['002_uploaded_status.sql', '003_extraction_outcomes.sql', '004_job_claims.sql']);
      expect(repeatUpgrade.applied).toEqual([]);
      expect(upgraded.rows[0]).toEqual({
        upload_id: uploadId,
        bucket: 'legacy-pdfs',
        object_key: objectKey,
        status: 'uploaded',
        upload_expires_at: expiry,
        next_check_at: nextCheck,
        page_count: null,
        error_code: null,
        claim_token: null,
        lease_expires_at: null,
      });
    } finally {
      await scopedPool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });
});
