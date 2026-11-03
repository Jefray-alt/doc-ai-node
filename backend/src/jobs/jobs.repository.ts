import type { Pool } from 'pg';

export type JobStatus = 'awaiting_upload' | 'pending_dispatch' | 'expired';

export interface JobRecord {
  uploadId: string;
  bucket: string;
  objectKey: string;
  status: JobStatus;
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
    uploadExpiresAt: row.upload_expires_at,
    nextCheckAt: row.next_check_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class JobsRepository {
  constructor(private readonly pool: Pool) {}

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

  async findDueAwaitingUploads(limit: number, now: Date): Promise<JobRecord[]> {
    const result = await this.pool.query<JobRow>(
      `SELECT * FROM jobs
       WHERE status = 'awaiting_upload' AND next_check_at <= $1
       ORDER BY next_check_at, created_at
       LIMIT $2`,
      [now, limit],
    );

    return result.rows.map(toJobRecord);
  }

  async confirmUpload(uploadId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE jobs SET status = 'pending_dispatch', updated_at = now()
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
}
