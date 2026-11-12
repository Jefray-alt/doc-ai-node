ALTER TABLE jobs DROP CONSTRAINT jobs_status_check;

UPDATE jobs
SET status = 'uploaded', updated_at = now()
WHERE status = 'pending_dispatch';

ALTER TABLE jobs
  ADD CONSTRAINT jobs_status_check
  CHECK (status IN ('awaiting_upload', 'uploaded', 'expired'));
