import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobsStorageService } from '../src/jobs/jobs-storage.service.js';
import { runMigrations } from '../src/jobs/migrations.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('PostgreSQL jobs storage', () => {
  const schemaName = `jobs_test_${randomUUID().replaceAll('-', '')}`;
  const adminPool = new Pool({ connectionString: databaseUrl });
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });
  const jobs = new JobsStorageService(pool);

  beforeAll(async () => {
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
    await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
    await adminPool.end();
  });

  it('inserts the job and its outbox entry atomically and resolves concurrent duplicate creates', async () => {
    const input = {
      uploadId: randomUUID(),
      bucket: 'doc-ai-local-quarantine',
      key: `uploads/${randomUUID()}.pdf`,
      etag: 'etag-1',
      sizeBytes: 1024,
    };

    const results = await Promise.all([jobs.createJob(input), jobs.createJob(input)]);
    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(await pool.query('SELECT count(*)::int AS count FROM upload_jobs WHERE upload_id = $1', [input.uploadId])).toMatchObject({ rows: [{ count: 1 }] });
    expect(await pool.query('SELECT count(*)::int AS count FROM job_outbox WHERE upload_id = $1', [input.uploadId])).toMatchObject({ rows: [{ count: 1 }] });
  });

  it('allows only one live claimant, reclaims an expired lease, and fences the stale owner', async () => {
    const input = {
      uploadId: randomUUID(),
      bucket: 'doc-ai-local-quarantine',
      key: `uploads/${randomUUID()}.pdf`,
      etag: 'etag-2',
      sizeBytes: 2048,
    };
    await jobs.createJob(input);

    const firstToken = randomUUID();
    const secondToken = randomUUID();
    const claims = await Promise.all([
      jobs.claimJob(input.uploadId, firstToken, 60_000),
      jobs.claimJob(input.uploadId, secondToken, 60_000),
    ]);
    expect(claims.filter((claim) => claim.kind === 'claimed')).toHaveLength(1);
    expect(claims.filter((claim) => claim.kind === 'busy')).toHaveLength(1);

    await pool.query("UPDATE upload_jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE upload_id = $1", [input.uploadId]);
    const reclaimed = await jobs.claimJob(input.uploadId, secondToken, 60_000);
    expect(reclaimed).toMatchObject({ kind: 'claimed', ownerToken: secondToken });
    expect(await jobs.renewJob(input.uploadId, firstToken, 60_000)).toBe(false);
    expect(await jobs.renewJob(input.uploadId, secondToken, 60_000)).toBe(true);
    expect(await jobs.finalizeJob(input.uploadId, firstToken)).toBe(false);
    expect(await jobs.finalizeJob(input.uploadId, secondToken)).toBe(true);
    expect(await jobs.finalizeJob(input.uploadId, secondToken)).toBe(true);
    expect(await jobs.claimJob(input.uploadId, randomUUID(), 60_000)).toMatchObject({ kind: 'terminal', status: 'source_checked' });
  });

  it('fences stale failure and keeps the safe error on terminal failure', async () => {
    const input = {
      uploadId: randomUUID(),
      bucket: 'doc-ai-local-quarantine',
      key: `uploads/${randomUUID()}.pdf`,
      etag: 'etag-fail',
      sizeBytes: 3072,
    };
    await jobs.createJob(input);
    const staleToken = randomUUID();
    const ownerToken = randomUUID();
    await jobs.claimJob(input.uploadId, staleToken, 60_000);
    await pool.query("UPDATE upload_jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE upload_id = $1", [input.uploadId]);
    await jobs.claimJob(input.uploadId, ownerToken, 60_000);

    expect(await jobs.failJob(input.uploadId, staleToken, 'stale failure')).toBe(false);
    expect(await jobs.failJob(input.uploadId, ownerToken, 'source object is unavailable')).toBe(true);
    expect(await jobs.failJob(input.uploadId, ownerToken, 'different repeated failure')).toBe(true);
    expect(await jobs.getJobStatus(input.uploadId)).toMatchObject({ status: 'failed', lastSafeError: 'source object is unavailable' });
  });

  it('supports expiring and fenced outbox claims and concurrent dispatch claims', async () => {
    const input = {
      uploadId: randomUUID(),
      bucket: 'doc-ai-local-quarantine',
      key: `uploads/${randomUUID()}.pdf`,
      etag: 'etag-3',
      sizeBytes: 4096,
    };
    await jobs.createJob(input);

    const staleToken = randomUUID();
    const currentToken = randomUUID();
    expect((await jobs.claimOutbox(10, staleToken, 60_000)).some((message) => message.uploadId === input.uploadId)).toBe(true);
    await pool.query("UPDATE job_outbox SET claim_expires_at = clock_timestamp() - interval '1 second' WHERE upload_id = $1", [input.uploadId]);
    expect(await jobs.claimOutbox(10, currentToken, 60_000)).toHaveLength(1);
    expect(await jobs.markOutboxSent(input.uploadId, staleToken)).toBe(false);
    expect(await jobs.releaseOutbox(input.uploadId, staleToken, 'stale release')).toBe(false);
    expect(await jobs.releaseOutbox(input.uploadId, currentToken, 'retry safely')).toBe(true);
    const retryToken = randomUUID();
    expect((await jobs.claimOutbox(10, retryToken, 60_000)).some((message) => message.uploadId === input.uploadId)).toBe(true);
    expect(await jobs.markOutboxSent(input.uploadId, retryToken)).toBe(true);
    expect(await jobs.markOutboxSent(input.uploadId, retryToken)).toBe(true);
    expect(await jobs.claimOutbox(10, randomUUID(), 60_000)).toHaveLength(0);

    const concurrentInputs = [0, 1].map(() => ({
      uploadId: randomUUID(),
      bucket: 'doc-ai-local-quarantine',
      key: `uploads/${randomUUID()}.pdf`,
      etag: 'etag-concurrent-dispatch',
      sizeBytes: 512,
    }));
    await Promise.all(concurrentInputs.map((job) => jobs.createJob(job)));
    const concurrentTokens = [randomUUID(), randomUUID()];
    const dispatchClaims = await Promise.all(concurrentTokens.map((token) => jobs.claimOutbox(1, token, 60_000)));
    expect(dispatchClaims.flat()).toHaveLength(2);
    expect(new Set(dispatchClaims.flat().map((message) => message.uploadId)).size).toBe(2);
  });

  it('applies migrations repeatedly without changing the schema version', async () => {
    await runMigrations(pool);
    await runMigrations(pool);
    const versions = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
    expect(versions.rows.map((row: { version: string }) => row.version)).toEqual(['001_jobs_and_outbox']);
  });

  it('runs the copied compiled migration with no source tree and no .env file', async () => {
    const isolatedSchema = `jobs_dist_${randomUUID().replaceAll('-', '')}`;
    const isolatedDirectory = await mkdtemp(join(tmpdir(), 'jobs-migration-dist-'));
    const isolatedJobs = join(isolatedDirectory, 'dist', 'jobs');
    await adminPool.query(`CREATE SCHEMA ${isolatedSchema}`);

    try {
      await cp(resolve(process.cwd(), 'dist/jobs'), isolatedJobs, { recursive: true });
      await symlink(resolve(process.cwd(), 'node_modules'), join(isolatedDirectory, 'node_modules'), 'dir');
      const isolatedUrl = new URL(databaseUrl!);
      isolatedUrl.searchParams.set('options', `-c search_path=${isolatedSchema}`);
      execFileSync(process.execPath, [join(isolatedJobs, 'migrate.js')], {
        cwd: isolatedDirectory,
        env: { ...process.env, DATABASE_URL: isolatedUrl.toString() },
        stdio: 'pipe',
      });

      const isolatedPool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${isolatedSchema}` });
      const versions = await isolatedPool.query('SELECT version FROM schema_migrations ORDER BY version');
      expect(versions.rows.map((row: { version: string }) => row.version)).toEqual(['001_jobs_and_outbox']);
      await isolatedPool.end();
    } finally {
      await adminPool.query(`DROP SCHEMA ${isolatedSchema} CASCADE`);
      await rm(isolatedDirectory, { recursive: true, force: true });
    }
  });
});
