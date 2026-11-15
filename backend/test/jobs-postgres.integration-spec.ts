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
  const adminPool = new Pool({ connectionString: databaseUrl });
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

    const persisted = await repository.findByUploadId(uploadId);
    expect(persisted).toMatchObject({
      uploadId,
      bucket: 'integration-pdfs',
      objectKey,
      status: 'awaiting_upload',
    });

    const laterId = randomUUID();
    await repository.create({
      uploadId: laterId,
      bucket: 'integration-pdfs',
      objectKey: `integration/${laterId}.pdf`,
      status: 'awaiting_upload',
      uploadExpiresAt: new Date(Date.now() + 60_000),
      nextCheckAt: new Date(Date.now() - 1_000),
    });
    const due = await repository.findNextDueAwaitingUpload(new Date());
    expect(due?.uploadId).toBe(laterId);

    expect(await repository.retryUploadCheck(uploadId, new Date(Date.now() + 5_000))).toBe(true);
    expect(await repository.confirmUpload(uploadId)).toBe(true);
    expect(await repository.retryUploadCheck(uploadId, new Date())).toBe(false);
    expect(await repository.expireMissingUpload(uploadId)).toBe(false);
    expect(await repository.confirmUpload(uploadId)).toBe(false);
    await expect(repository.findByUploadId(uploadId)).resolves.toMatchObject({ status: 'uploaded' });

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

  it('selects only uploaded jobs due now, ordered by schedule then creation time', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    await expect(repository.findNextDueUploaded(now)).resolves.toBeNull();
    await createJob('uploaded', new Date(now.getTime() + 1));
    await createJob('awaiting_upload', new Date(now.getTime() - 30_000));
    await createJob('expired', new Date(now.getTime() - 30_000));
    const newer = await createJob('uploaded', new Date(now.getTime() - 10_000), now);
    const older = await createJob('uploaded', newer.nextCheckAt, new Date(now.getTime() - 1_000));
    const boundary = await createJob('uploaded', now, new Date(now.getTime() - 20_000));

    await expect(repository.findNextDueUploaded(now)).resolves.toMatchObject({ uploadId: older.uploadId });
    await repository.failExtraction(older.uploadId, 'INVALID_PDF');
    await expect(repository.findNextDueUploaded(now)).resolves.toMatchObject({ uploadId: newer.uploadId });
    await repository.completeExtraction(newer.uploadId, 2);
    await expect(repository.findNextDueUploaded(now)).resolves.toMatchObject({ uploadId: boundary.uploadId });
    await repository.completeExtraction(boundary.uploadId, 1);
    await expect(repository.findNextDueUploaded(now)).resolves.toBeNull();
  });

  it('persists operational retries and clears their error after successful extraction', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const job = await createJob('uploaded', now);
    const retryAt = new Date(now.getTime() + 5_000);

    expect(await repository.retryExtraction(job.uploadId, 'S3_UNAVAILABLE', retryAt)).toBe(true);
    await expect(repository.findByUploadId(job.uploadId)).resolves.toMatchObject({
      status: 'uploaded', pageCount: null, errorCode: 'S3_UNAVAILABLE', nextCheckAt: retryAt,
    });
    await expect(repository.findNextDueUploaded(now)).resolves.toBeNull();
    await expect(repository.findNextDueUploaded(retryAt)).resolves.toMatchObject({ uploadId: job.uploadId });

    expect(await repository.completeExtraction(job.uploadId, 3)).toBe(true);
    await expect(repository.findByUploadId(job.uploadId)).resolves.toMatchObject({
      status: 'extracted', pageCount: 3, errorCode: null,
    });
  });

  it('retains terminal failure codes without a page count', async () => {
    const job = await createJob('uploaded', new Date());
    await repository.retryExtraction(job.uploadId, 'S3_UNAVAILABLE', new Date(Date.now() + 5_000));

    expect(await repository.failExtraction(job.uploadId, 'INVALID_PDF')).toBe(true);
    await expect(repository.findByUploadId(job.uploadId)).resolves.toMatchObject({
      status: 'failed', pageCount: null, errorCode: 'INVALID_PDF',
    });
  });

  it('guards every extraction update against missing jobs and all other statuses', async () => {
    const now = new Date();
    const awaiting = await createJob('awaiting_upload', now);
    const expired = await createJob('expired', now);
    const extracted = await createJob('uploaded', now);
    const failed = await createJob('uploaded', now);
    await repository.completeExtraction(extracted.uploadId, 2);
    await repository.failExtraction(failed.uploadId, 'ENCRYPTED_PDF');

    for (const uploadId of [awaiting.uploadId, expired.uploadId, extracted.uploadId, failed.uploadId, randomUUID()]) {
      const before = await repository.findByUploadId(uploadId);
      expect(await repository.completeExtraction(uploadId, 9)).toBe(false);
      expect(await repository.failExtraction(uploadId, 'INVALID_PDF')).toBe(false);
      expect(await repository.retryExtraction(uploadId, 'S3_UNAVAILABLE', new Date(now.getTime() + 5_000))).toBe(false);
      await expect(repository.findByUploadId(uploadId)).resolves.toEqual(before);
    }
  });

  it('requires positive physical page counts on extracted jobs only', async () => {
    const job = await createJob('uploaded', new Date());

    for (const pageCount of [0, -1]) {
      await expect(repository.completeExtraction(job.uploadId, pageCount)).rejects.toMatchObject({ code: '23514' });
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
        `SELECT upload_id, bucket, object_key, status, upload_expires_at, next_check_at, page_count, error_code
         FROM jobs WHERE upload_id = $1`,
        [uploadId],
      );

      expect(firstUpgrade.applied).toEqual(['002_uploaded_status.sql', '003_extraction_outcomes.sql']);
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
      });
    } finally {
      await scopedPool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });
});
