CREATE TABLE IF NOT EXISTS input_requests (
  id                 uuid PRIMARY KEY,
  job_id             uuid        NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  attempt_id         uuid        NOT NULL REFERENCES attempts (id) ON DELETE CASCADE,
  attempt_number     integer     NOT NULL,
  runner_request_id  text        NOT NULL,
  kind               text        NOT NULL CHECK (kind IN ('permission','question')),
  request            jsonb       NOT NULL,
  state              text        NOT NULL CHECK (state IN ('pending','answered','expired','cancelled')),
  response           jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  resolved_at        timestamptz,
  answered_by        text,
  CONSTRAINT input_requests_attempt_runner UNIQUE (attempt_id, runner_request_id)
);

CREATE INDEX IF NOT EXISTS input_requests_job_created ON input_requests (job_id, created_at);
CREATE INDEX IF NOT EXISTS input_requests_pending_lookup ON input_requests (state, expires_at, created_at) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS input_requests_attempt_pending ON input_requests (attempt_id, created_at) WHERE state = 'pending';
