ALTER TABLE jobs DROP CONSTRAINT jobs_status_check;

ALTER TABLE jobs
  ADD COLUMN page_count integer CHECK (page_count > 0),
  ADD COLUMN error_code text,
  ADD CONSTRAINT jobs_status_check
    CHECK (status IN ('awaiting_upload', 'uploaded', 'expired', 'extracted', 'failed')),
  ADD CONSTRAINT jobs_extraction_page_count_check
    CHECK ((status = 'extracted') = (page_count IS NOT NULL)),
  ADD CONSTRAINT jobs_failed_error_code_check
    CHECK (status <> 'failed' OR error_code IS NOT NULL);

CREATE INDEX jobs_uploaded_due_idx
  ON jobs (next_check_at, created_at)
  WHERE status = 'uploaded';
