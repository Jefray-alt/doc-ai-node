CREATE TYPE upload_job_status AS ENUM ('queued', 'processing', 'source_checked', 'failed');

CREATE TABLE upload_jobs (
  upload_id UUID PRIMARY KEY,
  bucket TEXT NOT NULL,
  object_key TEXT NOT NULL,
  etag TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  status upload_job_status NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_safe_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  lease_expires_at TIMESTAMPTZ,
  owner_token UUID
);

CREATE TABLE job_outbox (
  outbox_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  upload_id UUID NOT NULL UNIQUE REFERENCES upload_jobs(upload_id) ON DELETE CASCADE,
  payload_version SMALLINT NOT NULL DEFAULT 1 CHECK (payload_version = 1),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sent')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  sent_at TIMESTAMPTZ,
  dispatch_attempts INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_attempts >= 0),
  last_dispatch_error TEXT,
  claim_expires_at TIMESTAMPTZ,
  claim_owner_token UUID,
  CHECK ((state = 'pending' AND sent_at IS NULL) OR (state = 'sent' AND sent_at IS NOT NULL))
);

CREATE INDEX job_outbox_pending_created_idx ON job_outbox (created_at, outbox_id) WHERE state = 'pending';
CREATE INDEX upload_jobs_claimable_idx ON upload_jobs (created_at, upload_id) WHERE status IN ('queued', 'processing');
