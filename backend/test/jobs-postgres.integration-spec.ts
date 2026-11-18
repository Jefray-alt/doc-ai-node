import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { closeDatabasePool, getDatabasePool } from '../src/database/database.pool.js';
import { migrateDatabase } from '../src/database/migrations/migrate.js';
import { JobsRepository } from '../src/jobs/jobs.repository.js';
import { JobsReconciler } from '../src/jobs/jobs.reconciler.ts';
import type { JobStatus } from '../src/jobs/jobs.repository.js';
import type { PdfPageConsumer } from '../src/ingestion/pdf-extractor.types.ts';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for the PostgreSQL integration suite');
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
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

  // Keep worker checks in this sequential suite, after its fresh-schema migration
  // test. Independent pools model workers without sharing any in-process state.
  function workerFixture() {
    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const jobs = new JobsRepository(pool);
    const gate = deferred<void>();
    const started = deferred<void>();
    const statuses: string[] = [];
    const s3 = { send: vi.fn(async () => {
      statuses.push('awaiting_upload');
      started.resolve();
      await gate.promise;
      return {};
    }) };
    const ingestion = { extract: vi.fn(async (_bucket: string, _key: string, consume: PdfPageConsumer) => {
      statuses.push('uploaded');
      started.resolve();
      await gate.promise; // A parser may continue even after its signal is aborted.
      await consume({ pageNumber: 1, text: 'controlled page' });
    }) };
    const worker = new JobsReconciler(jobs, s3 as never, ingestion as never);
    return { pool, jobs, gate, started, statuses, worker };
  }

  async function closeWorkers(workers: ReturnType<typeof workerFixture>[], cycles: Promise<void>[]) {
    const shutdowns = workers.map(({ worker }) => worker.onModuleDestroy());
    for (const { gate } of workers) gate.resolve();
    await Promise.all([...cycles, ...shutdowns]);
    await Promise.all(workers.map(({ pool }) => pool.end()));
  }

  it.each(workStatuses)('two independent workers handle different %s jobs concurrently, one per worker', async (status) => {
    const jobs = [await createJob(status, dueAt()), await createJob(status, dueAt())];
    const workers = [workerFixture(), workerFixture()];
    const cycles = workers.map(({ worker }) => worker.reconcileOnce());
    try {
      await Promise.all(workers.map(({ started }) => started.promise));
      const owned = await Promise.all(jobs.map(({ uploadId }) => repository.findByUploadId(uploadId)));
      expect(owned.every((job) => job?.claimToken && job.leaseExpiresAt!.getTime() > Date.now())).toBe(true);
      expect(new Set(owned.map((job) => job!.claimToken)).size).toBe(2);
      await expect(claimNext(repository, status)).resolves.toBeNull();
      // Even explicit concurrent calls cannot start a second job inside a worker.
      cycles.push(...workers.map(({ worker }) => worker.reconcileOnce()));
      for (const fixture of workers) expect(fixture.statuses).toEqual([status]);
      for (const { gate } of workers) gate.resolve();
      await Promise.all(cycles);
      for (const { uploadId } of jobs) {
        await expect(repository.findByUploadId(uploadId)).resolves.toMatchObject({
          status: status === 'uploaded' ? 'extracted' : 'uploaded',
          claimToken: null, leaseExpiresAt: null,
          pageCount: status === 'uploaded' ? 1 : null,
        });
      }
    } finally {
      await closeWorkers(workers, cycles);
    }
  });

  it.each(workStatuses)('an expired %s attempt cannot overwrite a replacement worker, even while it is still active', async (status) => {
    const job = await createJob(status, dueAt());
    const old = workerFixture();
    const replacement = workerFixture();
    const outcome = vi.spyOn(old.jobs, status === 'uploaded' ? 'completeExtraction' : 'confirmUpload');
    const cycles = [old.worker.reconcileOnce()];
    try {
      await old.started.promise;
      const first = (await repository.findByUploadId(job.uploadId))!;
      await replacement.worker.reconcileOnce();
      expect(replacement.statuses).toEqual([]); // A live lease excludes another worker.
      await expireClaim(job.uploadId); // Deterministic crash/slow-parser recovery, no lease-length sleep.
      cycles.push(replacement.worker.reconcileOnce());
      await replacement.started.promise;
      const replaced = (await repository.findByUploadId(job.uploadId))!;
      expect(replaced.claimToken).not.toBe(first.claimToken);
      expect(replaced.claimToken).not.toBeNull();

      old.gate.resolve();
      await cycles[0];
      expect(outcome).toHaveBeenCalledOnce();
      await expect(outcome.mock.results[0]!.value).resolves.toBe(false);
      await expect(repository.findByUploadId(job.uploadId)).resolves.toEqual(replaced);
      replacement.gate.resolve();
      await cycles[1];
      await expect(repository.findByUploadId(job.uploadId)).resolves.toMatchObject({
        status: status === 'uploaded' ? 'extracted' : 'uploaded', claimToken: null,
      });
    } finally {
      await closeWorkers([old, replacement], cycles);
    }
  });

  it('reclaims a shutting-down parser and rejects its late release against a live replacement', async () => {
    const job = await createJob('uploaded', dueAt());
    const old = workerFixture();
    const replacement = workerFixture();
    const release = vi.spyOn(old.jobs, 'releaseClaim');
    const complete = vi.spyOn(old.jobs, 'completeExtraction');
    const cycles = [old.worker.reconcileOnce()];
    try {
      await old.started.promise;
      const shutdown = old.worker.onModuleDestroy();
      await expireClaim(job.uploadId);
      cycles.push(replacement.worker.reconcileOnce());
      await replacement.started.promise;
      const owned = await repository.findByUploadId(job.uploadId);
      old.gate.resolve();
      await shutdown;
      expect(complete).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
      await expect(release.mock.results[0]!.value).resolves.toBe(false);
      await expect(repository.findByUploadId(job.uploadId)).resolves.toEqual(owned);
      replacement.gate.resolve();
      await cycles[1];
      await expect(repository.findByUploadId(job.uploadId)).resolves.toMatchObject({
        status: 'extracted', pageCount: 1, claimToken: null,
      });
    } finally {
      await closeWorkers([old, replacement], cycles);
    }
  });

  it('keeps status alternation independent for each worker', async () => {
    for (const status of workStatuses) {
      for (let index = 0; index < 4; index++) await createJob(status, dueAt());
    }
    const workers = [workerFixture(), workerFixture()];
    try {
      for (const fixture of workers) {
        fixture.gate.resolve();
        for (let cycle = 0; cycle < 3; cycle++) await fixture.worker.reconcileOnce();
        expect(fixture.statuses).toEqual(['awaiting_upload', 'uploaded', 'awaiting_upload']);
      }
    } finally {
      await closeWorkers(workers, []);
    }
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

  it.each(workStatuses)('renews only the live matching %s claim and preserves its work fields', async (status) => {
    const job = await createJob(status, dueAt());
    const claim = (await claimNext(repository, status))!;
    await adminPool.query(
      "UPDATE jobs SET lease_expires_at = clock_timestamp() + interval '20 seconds' WHERE upload_id = $1",
      [job.uploadId],
    );
    const before = (await repository.findByUploadId(job.uploadId))!;
    expect(await repository.renewClaim(job.uploadId, claim.claimToken, status)).toBe(true);
    const after = (await repository.findByUploadId(job.uploadId))!;
    expect(after).toEqual({ ...before, leaseExpiresAt: expect.any(Date) });
    expect(after.leaseExpiresAt!.getTime()).toBeGreaterThan(before.leaseExpiresAt!.getTime() + 90_000);
    for (const invalid of ['wrong-token', 'wrong-status', 'expired', 'reclaimed']) {
      if (invalid === 'expired' || invalid === 'reclaimed') await expireClaim(job.uploadId);
      if (invalid === 'reclaimed') await claimNext(repository, status);
      const saved = await repository.findByUploadId(job.uploadId);
      expect(await repository.renewClaim(job.uploadId,
        invalid === 'wrong-token' ? randomUUID() : claim.claimToken,
        invalid === 'wrong-status' ? (status === 'uploaded' ? 'awaiting_upload' : 'uploaded') : status)).toBe(false);
      await expect(repository.findByUploadId(job.uploadId)).resolves.toEqual(saved);
    }
  });

  it.each(workStatuses)('cannot revive %s ownership that expires while renewal waits for a row lock', async (status) => {
    const job = await createJob(status, dueAt());
    const claim = (await claimNext(repository, status))!;
    await adminPool.query(
      "UPDATE jobs SET lease_expires_at = clock_timestamp() + interval '1 second' WHERE upload_id = $1", [job.uploadId],
    );
    const before = await repository.findByUploadId(job.uploadId);
    const holder = await adminPool.connect();
    let renewal: Promise<boolean> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT upload_id FROM jobs WHERE upload_id = $1 FOR UPDATE', [job.uploadId]);
      renewal = repository.renewClaim(job.uploadId, claim.claimToken, status);
      await expect.poll(async () => (await adminPool.query(
        "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
      )).rows[0].count).toBe(1);
      await holder.query(
        `SELECT pg_sleep(GREATEST(0, extract(epoch FROM (lease_expires_at - clock_timestamp()))) + 0.05)
         FROM jobs WHERE upload_id = $1`, [job.uploadId],
      );
      await holder.query('COMMIT');
      expect(await renewal).toBe(false);
      await expect(repository.findByUploadId(job.uploadId)).resolves.toEqual(before);
    } finally {
      await holder.query('ROLLBACK');
      await renewal?.catch(() => undefined);
      holder.release();
    }
  });

  it('cancels a blocked renewal on the server, rolls back, and cannot renew after the lock is released', async () => {
    const job = await createJob('uploaded', dueAt());
    const claim = (await repository.claimNextDueUploaded())!;
    const before = await repository.findByUploadId(job.uploadId);
    const holder = await adminPool.connect();
    const renewalPool = new Pool({ connectionString: databaseUrl, application_name: 't2a-statement-timeout' });
    let renewal: Promise<boolean> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT upload_id FROM jobs WHERE upload_id = $1 FOR UPDATE', [job.uploadId]);
      renewal = new JobsRepository(renewalPool).renewClaim(job.uploadId, claim.claimToken, 'uploaded');
      await expect(renewal).rejects.toMatchObject({ code: '57014' });
      // A failed transaction retains locks until rollback/disconnect. Require the
      // entire backend to disappear, including idle-in-transaction sessions.
      await expect.poll(async () => (await adminPool.query(
        "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = 't2a-statement-timeout'",
      )).rows[0].count).toBe(0);
      await holder.query('COMMIT');
      await expect(repository.findByUploadId(job.uploadId)).resolves.toEqual(before);
    } finally {
      await holder.query('ROLLBACK');
      await renewal?.catch(() => undefined);
      holder.release();
      await renewalPool.end();
    }
  });

  it('disposes a running server request at the whole-request deadline after slow acquisition', async () => {
    const job = await createJob('uploaded', dueAt());
    const claim = (await repository.claimNextDueUploaded())!;
    const before = await repository.findByUploadId(job.uploadId);
    const holder = await adminPool.connect();
    const renewalPool = new Pool({ connectionString: databaseUrl, application_name: 't2a-whole-request-timeout' });
    const delayedPool = { connect: (callback: Parameters<Pool['connect']>[0]) => {
      renewalPool.connect((error, client, release) => {
        setTimeout(() => callback(error, client, release), 3_500);
      });
    } };
    let renewal: Promise<boolean> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT upload_id FROM jobs WHERE upload_id = $1 FOR UPDATE', [job.uploadId]);
      renewal = new JobsRepository(delayedPool as never).renewClaim(job.uploadId, claim.claimToken, 'uploaded');
      const rejected = expect(renewal).rejects.toThrow('timed out');
      await expect.poll(async () => (await adminPool.query(
        "SELECT wait_event_type FROM pg_stat_activity WHERE application_name = 't2a-whole-request-timeout'",
      )).rows[0]?.wait_event_type, { timeout: 4_500 }).toBe('Lock');
      await rejected;
      await expect.poll(async () => (await adminPool.query(
        "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = 't2a-whole-request-timeout'",
      )).rows[0].count).toBe(0);
      await holder.query('COMMIT');
      await expect(repository.findByUploadId(job.uploadId)).resolves.toEqual(before);
    } finally {
      await holder.query('ROLLBACK');
      await renewal?.catch(() => undefined);
      holder.release();
      await renewalPool.end();
    }
  }, 10_000);

  it.each(['active-query', 'query-gap'])('survives a renewal socket loss during %s and rejects without a late commit', (phase) => {
    const script = `
      import assert from 'node:assert/strict';
      import { Pool } from 'pg';
      import { runClaimRenewal } from ${JSON.stringify(new URL('../src/jobs/jobs.claim-renewal.ts', import.meta.url).href)};
      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      pool.on('error', () => {});
      const client = await pool.connect();
      const query = client.query.bind(client);
      const release = client.release.bind(client);
      const queries = [];
      const releases = [];
      client.release = (error) => { releases.push(error); release(error); };
      client.query = (...args) => {
        queries.push(args[0]);
        if (${JSON.stringify(phase)} === 'query-gap' && queries.length === 1) {
          return query(...args).then(async (result) => {
            const ended = new Promise((resolve) => client.once('end', resolve));
            client.connection.stream.destroy();
            await ended;
            return result;
          });
        }
        if (${JSON.stringify(phase)} === 'active-query' && queries.length === 2) {
          const pending = query('SELECT pg_sleep(10)');
          setTimeout(() => client.connection.stream.destroy(), 20);
          return pending;
        }
        return query(...args);
      };
      const checkout = { connect: (callback) => {
        if (callback) { callback(undefined, client); return; }
        return Promise.resolve(client);
      } };
      try {
        await assert.rejects(runClaimRenewal(checkout, 'SELECT 1', []), /Connection terminated/);
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(releases, [true]);
        assert.equal(queries.length, ${phase === 'active-query' ? 2 : 1});
        assert.equal(queries.includes('COMMIT'), false);
        assert.equal(pool.totalCount, 0);
        console.log('SURVIVED: renewal rejected; disposed once; no late SQL or COMMIT');
      } finally {
        await pool.end();
      }
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: process.env,
      encoding: 'utf8',
      timeout: 8_000,
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('SURVIVED: renewal rejected; disposed once; no late SQL or COMMIT');
  });

  it('bounds renewal while its pool is exhausted and issues no late update', async () => {
    const job = await createJob('uploaded', dueAt());
    const claim = (await repository.claimNextDueUploaded())!;
    const before = await repository.findByUploadId(job.uploadId);
    const exhaustedPool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 100 });
    const held = await exhaustedPool.connect();
    try {
      await expect(new JobsRepository(exhaustedPool).renewClaim(job.uploadId, claim.claimToken, 'uploaded')).rejects.toThrow('timeout');
      expect(exhaustedPool.waitingCount).toBe(0);
    } finally {
      held.release();
      await exhaustedPool.end();
    }
    await expect(repository.findByUploadId(job.uploadId)).resolves.toEqual(before);
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
