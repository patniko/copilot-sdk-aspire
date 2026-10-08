-- Per-harness policy: each job records the effective policy that admitted it. Claim matching uses these
-- columns instead of one global eligibility check. NULL (jobs admitted before this migration) falls back to
-- the dispatcher's base policy.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS policy_digest text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS requires_uid_isolation boolean;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS requires_egress_enforcement boolean;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS policy_acknowledged_gaps text[];
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS retry_backoff_seconds integer;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS waiting_reported boolean NOT NULL DEFAULT false;
