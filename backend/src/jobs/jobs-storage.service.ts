import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import type { CreateJobInput, CreateJobResult, JobClaimResult, JobRecord, OutboxMessage } from './jobs.types.js';

interface JobRow extends QueryResultRow {
  upload_id: string;
  bucket: string;
  object_key: string;
  etag: string;
  size_bytes: string | number;
  status: JobRecord['status'];
  attempts: number;
  last_safe_error: string | null;
  created_at: Date;
  updated_at: Date;
  lease_expires_at: Date | null;
  owner_token: string | null;
}

@Injectable()
export class JobsStorageService implements OnModuleDestroy {
  constructor(@Inject(Pool) private readonly pool: Pool) {}

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  async createJob(input: CreateJobInput): Promise<CreateJobResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query<JobRow>(
        `INSERT INTO upload_jobs (upload_id, bucket, object_key, etag, size_bytes)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (upload_id) DO NOTHING
         RETURNING *`,
        [input.uploadId, input.bucket, input.key, input.etag, input.sizeBytes],
      );

      let row = inserted.rows[0];
      if (!row) {
        const existing = await client.query<JobRow>('SELECT * FROM upload_jobs WHERE upload_id = $1 FOR UPDATE', [input.uploadId]);
        row = existing.rows[0];
        if (!row || !sameObject(row, input)) {
          throw new Error(`Upload ${input.uploadId} already has a different immutable object reference`);
        }
      } else {
        await client.query(
          `INSERT INTO job_outbox (upload_id, payload_version)
           VALUES ($1, 1)
           ON CONFLICT (upload_id) DO NOTHING`,
          [input.uploadId],
        );
      }

      await client.query('COMMIT');
      return { created: inserted.rowCount === 1, job: toJobRecord(row) };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async getJobStatus(uploadId: string): Promise<JobRecord | null> {
    const result = await this.pool.query<JobRow>('SELECT * FROM upload_jobs WHERE upload_id = $1', [uploadId]);
    return result.rows[0] ? toJobRecord(result.rows[0]) : null;
  }

  async claimJob(uploadId: string, ownerToken: string, leaseMs: number): Promise<JobClaimResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query<JobRow & { lease_active: boolean }>(
        'SELECT *, lease_expires_at > clock_timestamp() AS lease_active FROM upload_jobs WHERE upload_id = $1 FOR UPDATE',
        [uploadId],
      );
      const row = selected.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return { kind: 'missing' };
      }
      if (row.status === 'source_checked' || row.status === 'failed') {
        await client.query('COMMIT');
        return { kind: 'terminal', status: row.status };
      }
      if (row.lease_active) {
        await client.query('COMMIT');
        return { kind: 'busy' };
      }

      const claimed = await client.query<JobRow>(
        `UPDATE upload_jobs
         SET status = 'processing', attempts = attempts + 1, owner_token = $2,
             lease_expires_at = clock_timestamp() + ($3 * interval '1 millisecond'), updated_at = clock_timestamp()
         WHERE upload_id = $1 AND status IN ('queued', 'processing')
         RETURNING *`,
        [uploadId, ownerToken, leaseMs],
      );
      await client.query('COMMIT');
      return claimed.rows[0]
        ? { kind: 'claimed', job: toJobRecord(claimed.rows[0]), ownerToken }
        : { kind: 'busy' };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async renewJob(uploadId: string, ownerToken: string, leaseMs: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE upload_jobs SET lease_expires_at = clock_timestamp() + ($3 * interval '1 millisecond'), updated_at = clock_timestamp()
       WHERE upload_id = $1 AND owner_token = $2 AND status = 'processing' AND lease_expires_at > clock_timestamp()`,
      [uploadId, ownerToken, leaseMs],
    );
    return result.rowCount === 1;
  }

  async finalizeJob(uploadId: string, ownerToken: string): Promise<boolean> {
    const updated = await this.pool.query(
      `UPDATE upload_jobs
       SET status = 'source_checked', owner_token = NULL, lease_expires_at = NULL,
           last_safe_error = NULL, updated_at = clock_timestamp()
       WHERE upload_id = $1 AND owner_token = $2 AND status = 'processing' AND lease_expires_at > clock_timestamp()`,
      [uploadId, ownerToken],
    );
    if (updated.rowCount === 1) return true;
    const current = await this.pool.query('SELECT status FROM upload_jobs WHERE upload_id = $1', [uploadId]);
    return current.rows[0]?.status === 'source_checked';
  }

  async failJob(uploadId: string, ownerToken: string, lastSafeError: string): Promise<boolean> {
    const updated = await this.pool.query(
      `UPDATE upload_jobs
       SET status = 'failed', owner_token = NULL, lease_expires_at = NULL,
           last_safe_error = $3, updated_at = clock_timestamp()
       WHERE upload_id = $1 AND owner_token = $2 AND status = 'processing' AND lease_expires_at > clock_timestamp()`,
      [uploadId, ownerToken, lastSafeError.slice(0, 500)],
    );
    if (updated.rowCount === 1) return true;
    const current = await this.pool.query('SELECT status FROM upload_jobs WHERE upload_id = $1', [uploadId]);
    return current.rows[0]?.status === 'failed';
  }

  async claimOutbox(limit: number, ownerToken: string, leaseMs: number): Promise<OutboxMessage[]> {
    const result = await this.pool.query(
      `WITH candidates AS (
         SELECT outbox_id FROM job_outbox
         WHERE state = 'pending' AND (claim_expires_at IS NULL OR claim_expires_at <= clock_timestamp())
         ORDER BY created_at, outbox_id
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       ), claimed AS (
         UPDATE job_outbox AS outbox
         SET claim_owner_token = $2,
             claim_expires_at = clock_timestamp() + ($3 * interval '1 millisecond'),
             dispatch_attempts = dispatch_attempts + 1
         FROM candidates
         WHERE outbox.outbox_id = candidates.outbox_id
         RETURNING outbox.upload_id, outbox.payload_version, outbox.claim_owner_token
       )
       SELECT jobs.upload_id, claimed.payload_version, jobs.bucket, jobs.object_key, jobs.etag, jobs.size_bytes
       FROM claimed JOIN upload_jobs AS jobs USING (upload_id)
       ORDER BY jobs.created_at, jobs.upload_id`,
      [limit, ownerToken, leaseMs],
    );
    return result.rows.map((row) => ({
      uploadId: row.upload_id,
      payloadVersion: row.payload_version,
      bucket: row.bucket,
      key: row.object_key,
      etag: row.etag,
      sizeBytes: Number(row.size_bytes),
      ownerToken,
    }));
  }

  async releaseOutbox(uploadId: string, ownerToken: string, safeError?: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE job_outbox
       SET claim_owner_token = NULL, claim_expires_at = NULL, last_dispatch_error = $3
       WHERE upload_id = $1 AND state = 'pending' AND claim_owner_token = $2 AND claim_expires_at > clock_timestamp()`,
      [uploadId, ownerToken, safeError?.slice(0, 500) ?? null],
    );
    return result.rowCount === 1;
  }

  async markOutboxSent(uploadId: string, ownerToken: string): Promise<boolean> {
    const updated = await this.pool.query(
      `UPDATE job_outbox
       SET state = 'sent', sent_at = clock_timestamp(), claim_owner_token = NULL, claim_expires_at = NULL,
           last_dispatch_error = NULL
       WHERE upload_id = $1 AND state = 'pending' AND claim_owner_token = $2 AND claim_expires_at > clock_timestamp()`,
      [uploadId, ownerToken],
    );
    if (updated.rowCount === 1) return true;
    const current = await this.pool.query('SELECT state FROM job_outbox WHERE upload_id = $1', [uploadId]);
    return current.rows[0]?.state === 'sent';
  }
}

function toJobRecord(row: JobRow): JobRecord {
  return {
    uploadId: row.upload_id,
    bucket: row.bucket,
    key: row.object_key,
    etag: row.etag,
    sizeBytes: Number(row.size_bytes),
    status: row.status,
    attempts: row.attempts,
    lastSafeError: row.last_safe_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    leaseExpiresAt: row.lease_expires_at,
    ownerToken: row.owner_token,
  };
}

function sameObject(row: JobRow, input: CreateJobInput): boolean {
  return row.bucket === input.bucket && row.object_key === input.key && row.etag === input.etag && Number(row.size_bytes) === input.sizeBytes;
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original database error when the connection already rolled back.
  }
}
