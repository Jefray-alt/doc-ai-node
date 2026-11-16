import type { Pool } from 'pg';
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE_POOL } from '../database/database.module.ts';

export type JobStatus = 'awaiting_upload' | 'uploaded' | 'expired' | 'extracted' | 'failed';

export interface JobRecord {
  uploadId: string;
  bucket: string;
  objectKey: string;
  status: JobStatus;
  pageCount: number | null;
  errorCode: string | null;
  uploadExpiresAt: Date;
  nextCheckAt: Date;
  createdAt: Date;
  updatedAt: Date;
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

  async findNextDueAwaitingUpload(now: Date): Promise<JobRecord | null> {
    const result = await this.pool.query<JobRow>(
      `SELECT * FROM jobs
       WHERE status = 'awaiting_upload' AND next_check_at <= $1
       ORDER BY next_check_at, created_at
       LIMIT 1`,
      [now],
    );

    const row = result.rows[0];
    return row ? toJobRecord(row) : null;
  }

  async confirmUpload(uploadId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE jobs SET status = 'uploaded', updated_at = now()
       WHERE upload_id = $1 AND status = 'awaiting_upload'`,
      [uploadId],
    );

    return result.rowCount === 1;
  }

  async retryUploadCheck(uploadId: string, nextCheckAt: Date): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE jobs SET next_check_at = $2, updated_at = now()
       WHERE upload_id = $1 AND status = 'awaiting_upload'`,
      [uploadId, nextCheckAt],
    );

    return result.rowCount === 1;
  }

  async expireMissingUpload(uploadId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE jobs SET status = 'expired', updated_at = now()
       WHERE upload_id = $1 AND status = 'awaiting_upload'`,
      [uploadId],
    );

    return result.rowCount === 1;
  }

  async findNextDueUploaded(now: Date): Promise<JobRecord | null> {
    const result = await this.pool.query<JobRow>(
      `SELECT * FROM jobs
       WHERE status = 'uploaded' AND next_check_at <= $1
       ORDER BY next_check_at, created_at
       LIMIT 1`,
      [now],
    );

    const row = result.rows[0];
    return row ? toJobRecord(row) : null;
  }

  async completeExtraction(uploadId: string, pageCount: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE jobs
       SET status = 'extracted', page_count = $2, error_code = NULL, updated_at = now()
       WHERE upload_id = $1 AND status = 'uploaded'`,
      [uploadId, pageCount],
    );

    return result.rowCount === 1;
  }

  async failExtraction(uploadId: string, errorCode: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE jobs
       SET status = 'failed', page_count = NULL, error_code = $2, updated_at = now()
       WHERE upload_id = $1 AND status = 'uploaded'`,
      [uploadId, errorCode],
    );

    return result.rowCount === 1;
  }

  async retryExtraction(uploadId: string, errorCode: string, nextCheckAt: Date): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE jobs SET error_code = $2, next_check_at = $3, updated_at = now()
       WHERE upload_id = $1 AND status = 'uploaded'`,
      [uploadId, errorCode, nextCheckAt],
    );

    return result.rowCount === 1;
  }
}
