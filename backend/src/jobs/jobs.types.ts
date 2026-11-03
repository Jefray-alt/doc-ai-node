export type JobStatus = 'queued' | 'processing' | 'source_checked' | 'failed';

export interface CreateJobInput {
  uploadId: string;
  bucket: string;
  key: string;
  etag: string;
  sizeBytes: number;
}

export interface JobRecord extends CreateJobInput {
  status: JobStatus;
  attempts: number;
  lastSafeError: string | null;
  createdAt: Date;
  updatedAt: Date;
  leaseExpiresAt: Date | null;
  ownerToken: string | null;
}

export interface CreateJobResult {
  created: boolean;
  job: JobRecord;
}

export type JobClaimResult =
  | { kind: 'claimed'; job: JobRecord; ownerToken: string }
  | { kind: 'busy' }
  | { kind: 'terminal'; status: 'source_checked' | 'failed' }
  | { kind: 'missing' };

export interface OutboxMessage {
  uploadId: string;
  payloadVersion: 1;
  bucket: string;
  key: string;
  etag: string;
  sizeBytes: number;
  ownerToken: string;
}
