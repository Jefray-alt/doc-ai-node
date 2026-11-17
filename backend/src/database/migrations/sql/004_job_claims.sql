ALTER TABLE jobs
  ADD COLUMN claim_token uuid,
  ADD COLUMN lease_expires_at timestamptz,
  ADD CONSTRAINT jobs_claim_pair_check
    CHECK ((claim_token IS NULL) = (lease_expires_at IS NULL)),
  ADD CONSTRAINT jobs_claim_status_check
    CHECK (claim_token IS NULL OR status IN ('awaiting_upload', 'uploaded'));
