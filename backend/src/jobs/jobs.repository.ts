import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE_POOL } from '../database/database.module.ts';
import { runClaimRenewal } from './jobs.claim-renewal.ts';

export const JOB_LEASE_MS = 2 * 60_000;

export type ClaimableJobStatus = 'awaiting_upload' | 'uploaded';
export type JobStatus = 'awaiting_upload' | 'uploaded' | 'expired' | 'extracted' | 'failed';

export interface JobRecord {
  uploadId: string;
  bucket: string;
  objectKey: string;
  status: JobStatus;
  pageCount: number | null;
  errorCode: string | null;
  claimToken: string | null;
  leaseExpiresAt: Date | null;
  uploadExpiresAt: Date;
  nextCheckAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ClaimedJobRecord extends JobRecord {
  status: ClaimableJobStatus;
  claimToken: string;
  leaseExpiresAt: Date;
}

export interface CreateJobInput {
  uploadId: string;
  bucket: string;
  objectKey: string;
  status: JobStatus;
  uploadExpiresAt: Date;
  nextCheckAt: Date;
}

interface JobRow {
  upload_id: string;
  bucket: string;
  object_key: string;
  status: JobStatus;
  page_count: number | null;
  error_code: string | null;
  claim_token: string | null;
  lease_expires_at: Date | null;
  upload_expires_at: Date;
  next_check_at: Date;
  created_at: Date;
  updated_at: Date;
}

function toJobRecord(row: JobRow): JobRecord {
  return {
    uploadId: row.upload_id,
    bucket: row.bucket,
    objectKey: row.object_key,
    status: row.status,
    pageCount: row.page_count,
    errorCode: row.error_code,
    claimToken: row.claim_token,
    leaseExpiresAt: row.lease_expires_at,
    uploadExpiresAt: row.upload_expires_at,
    nextCheckAt: row.next_check_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

@Injectable()
export class JobsRepository {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  async create(input: CreateJobInput): Promise<JobRecord> {
    const result = await this.pool.query<JobRow>(
      `INSERT INTO jobs
        (upload_id, bucket, object_key, status, upload_expires_at, next_check_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.uploadId,
        input.bucket,
        input.objectKey,
        input.status,
        input.uploadExpiresAt,
        input.nextCheckAt,
      ],
    );

    return toJobRecord(result.rows[0]!);
  }

  async findByUploadId(uploadId: string): Promise<JobRecord | null> {
    const result = await this.pool.query<JobRow>(
      'SELECT * FROM jobs WHERE upload_id = $1',
      [uploadId],
    );
    const row = result.rows[0];

    return row ? toJobRecord(row) : null;
  }

  claimNextDueAwaitingUpload(): Promise<ClaimedJobRecord | null> {
    return this.claimNextDue('awaiting_upload');
  }

  claimNextDueUploaded(): Promise<ClaimedJobRecord | null> {
    return this.claimNextDue('uploaded');
  }

  private async claimNextDue(status: ClaimableJobStatus): Promise<ClaimedJobRecord | null> {
    const result = await this.pool.query<JobRow>(
      `WITH candidate AS (
         SELECT upload_id FROM jobs
         WHERE status = $1 AND next_check_at <= statement_timestamp()
           AND (claim_token IS NULL OR lease_expires_at <= clock_timestamp())
         ORDER BY next_check_at, created_at, upload_id
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE jobs AS job
       SET claim_token = $2, lease_expires_at = clock_timestamp() + $3 * interval '1 millisecond',
           updated_at = clock_timestamp()
       FROM candidate
       WHERE job.upload_id = candidate.upload_id
       RETURNING job.*`,
      [status, randomUUID(), JOB_LEASE_MS],
    );

    const row = result.rows[0];
    // The claim update and database constraints guarantee non-null ownership.
    return row ? toJobRecord(row) as ClaimedJobRecord : null;
  }

  renewClaim(uploadId: string, claimToken: string, expectedStatus: ClaimableJobStatus): Promise<boolean> {
    return runClaimRenewal(this.pool,
      `WITH locked AS MATERIALIZED (
         SELECT upload_id, claim_token, status, lease_expires_at FROM jobs
         WHERE upload_id = $1
         FOR UPDATE
       )
       UPDATE jobs SET lease_expires_at = clock_timestamp() + $4 * interval '1 millisecond'
       WHERE upload_id = (
         SELECT upload_id FROM locked
         WHERE claim_token = $2 AND status = $3 AND lease_expires_at > clock_timestamp()
       )`,
      [uploadId, claimToken, expectedStatus, JOB_LEASE_MS],
    );
  }

  confirmUpload(uploadId: string, claimToken: string): Promise<boolean> {
    return this.updateClaim(uploadId, claimToken, 'awaiting_upload', ["status = 'uploaded'"]);
  }

  retryUploadCheck(uploadId: string, claimToken: string, nextCheckAt: Date): Promise<boolean> {
    return this.updateClaim(uploadId, claimToken, 'awaiting_upload', ['next_check_at = $4'], [nextCheckAt]);
  }

  expireMissingUpload(uploadId: string, claimToken: string): Promise<boolean> {
    return this.updateClaim(uploadId, claimToken, 'awaiting_upload', ["status = 'expired'"]);
  }

  completeExtraction(uploadId: string, claimToken: string, pageCount: number): Promise<boolean> {
    return this.updateClaim(uploadId, claimToken, 'uploaded', [
      "status = 'extracted'", 'page_count = $4', 'error_code = NULL',
    ], [pageCount]);
  }

  failExtraction(uploadId: string, claimToken: string, errorCode: string): Promise<boolean> {
    return this.updateClaim(uploadId, claimToken, 'uploaded', [
      "status = 'failed'", 'page_count = NULL', 'error_code = $4',
    ], [errorCode]);
  }

  retryExtraction(uploadId: string, claimToken: string, errorCode: string, nextCheckAt: Date): Promise<boolean> {
    return this.updateClaim(uploadId, claimToken, 'uploaded', [
      'error_code = $4', 'next_check_at = $5',
    ], [errorCode, nextCheckAt]);
  }

  releaseClaim(uploadId: string, claimToken: string, expectedStatus: ClaimableJobStatus): Promise<boolean> {
    return this.updateClaim(uploadId, claimToken, expectedStatus);
  }

  private async updateClaim(
    uploadId: string,
    claimToken: string,
    expectedStatus: ClaimableJobStatus,
    changes: string[] = [],
    values: unknown[] = [],
  ): Promise<boolean> {
    // Lock first: a predicate on UPDATE alone can be evaluated before a lock wait.
    // Materialization makes the ownership and current-time check happen afterward.
    const result = await this.pool.query(
      `WITH locked AS MATERIALIZED (
         SELECT upload_id, claim_token, status, lease_expires_at FROM jobs
         WHERE upload_id = $1
         FOR UPDATE
       )
       UPDATE jobs SET ${[
         ...changes, 'claim_token = NULL', 'lease_expires_at = NULL', 'updated_at = clock_timestamp()',
       ].join(', ')}
       WHERE upload_id = (
         SELECT upload_id FROM locked
         WHERE claim_token = $2 AND status = $3 AND lease_expires_at > clock_timestamp()
       )`,
      [uploadId, claimToken, expectedStatus, ...values],
    );

    return result.rowCount === 1;
  }
}
