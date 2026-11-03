import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { closeDatabasePool, getDatabasePool } from '../src/database/database.pool.js';
import { migrateDatabase } from '../src/database/migrations/migrate.js';
import { JobsRepository } from '../src/jobs/jobs.repository.js';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for the PostgreSQL integration suite');
}

describe('PostgreSQL upload jobs', () => {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const repository = new JobsRepository(getDatabasePool());

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
      bucket: 'integration-quarantine',
      objectKey,
      status: 'awaiting_upload',
      uploadExpiresAt: new Date(Date.now() + 60_000),
      nextCheckAt: new Date(),
    });

    expect(created.uploadId).toBe(uploadId);
    expect(created.status).toBe('awaiting_upload');

    const persisted = await repository.findByUploadId(uploadId);
    expect(persisted).toMatchObject({
      uploadId,
      bucket: 'integration-quarantine',
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
          'integration-quarantine',
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
          'integration-quarantine',
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
          'integration-quarantine',
          'integration/expired.pdf',
          'awaiting_upload',
          null,
          new Date(),
        ],
      ),
    ).rejects.toMatchObject({ code: '23502' });
  });
});
