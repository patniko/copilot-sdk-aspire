-- Authoritative job ledger. SDK sessions are execution context; this schema is the source of truth.

CREATE TABLE IF NOT EXISTS jobs (
  id                    uuid PRIMARY KEY,
  principal             text        NOT NULL,
  idempotency_key       text,
  request_hash          text        NOT NULL,
  state                 text        NOT NULL CHECK (state IN ('queued','running','retry_wait','cancel_requested','succeeded','failed','cancelled','needs_review')),
  harness_name          text        NOT NULL,
  harness_version       text        NOT NULL,
  harness_digest        text        NOT NULL,
  harness_snapshot      jsonb       NOT NULL,
  profile               text        NOT NULL,
  model                 text        NOT NULL,
  input                 jsonb       NOT NULL,
  max_duration_seconds  integer     NOT NULL,
  token_budget          integer     NOT NULL,
  max_attempts          integer     NOT NULL,
  safe_to_retry         boolean     NOT NULL,
  attempts              integer     NOT NULL DEFAULT 0,
  not_before            timestamptz NOT NULL DEFAULT now(),
  cancel_requested      boolean     NOT NULL DEFAULT false,
  result                jsonb,
  error_code            text,
  error_message         text,
  input_tokens          bigint      NOT NULL DEFAULT 0,
  output_tokens         bigint      NOT NULL DEFAULT 0,
  inference_requests    integer     NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jobs_idempotency UNIQUE (principal, idempotency_key)
);

CREATE INDEX IF NOT EXISTS jobs_dispatchable ON jobs (not_before, created_at) WHERE state IN ('queued', 'retry_wait');
CREATE INDEX IF NOT EXISTS jobs_principal ON jobs (principal, created_at DESC);

CREATE TABLE IF NOT EXISTS attempts (
  id                     uuid PRIMARY KEY,
  job_id                 uuid        NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  number                 integer     NOT NULL,
  executor_id            text        NOT NULL,
  lease_token            text        NOT NULL,
  lease_expires_at       timestamptz NOT NULL,
  deadline               timestamptz NOT NULL,
  status                 text        NOT NULL CHECK (status IN ('running','succeeded','failed','cancelled','lost')),
  acknowledged_gaps      text[]      NOT NULL,
  executor_capabilities  jsonb       NOT NULL,
  provenance             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  error_code             text,
  started_at             timestamptz NOT NULL DEFAULT now(),
  finished_at            timestamptz,
  CONSTRAINT attempts_number UNIQUE (job_id, number)
);

CREATE INDEX IF NOT EXISTS attempts_running_leases ON attempts (lease_expires_at) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS capabilities (
  jti          uuid PRIMARY KEY,
  attempt_id   uuid        NOT NULL REFERENCES attempts (id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL,
  token_budget integer     NOT NULL,
  tokens_used  bigint      NOT NULL DEFAULT 0,
  revoked      boolean     NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job_events (
  seq     bigserial PRIMARY KEY,
  job_id  uuid        NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  at      timestamptz NOT NULL DEFAULT now(),
  body    jsonb       NOT NULL
);

CREATE INDEX IF NOT EXISTS job_events_job ON job_events (job_id, seq);
