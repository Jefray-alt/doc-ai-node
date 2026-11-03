CREATE TABLE jobs (
  upload_id uuid PRIMARY KEY,
  bucket text NOT NULL,
  object_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('awaiting_upload', 'pending_dispatch', 'expired')),
  upload_expires_at timestamptz NOT NULL,
  next_check_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jobs_bucket_object_key_unique UNIQUE (bucket, object_key)
);

CREATE INDEX jobs_awaiting_upload_due_idx
  ON jobs (next_check_at)
  WHERE status = 'awaiting_upload';
