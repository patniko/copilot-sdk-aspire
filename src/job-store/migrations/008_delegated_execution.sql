ALTER TABLE jobs ADD COLUMN execution_mode text NOT NULL DEFAULT 'pool' CHECK (execution_mode IN ('pool','dedicated'));
ALTER TABLE jobs ADD COLUMN budget_tokens_used bigint NOT NULL DEFAULT 0 CHECK (budget_tokens_used>=0);
UPDATE jobs SET budget_tokens_used=input_tokens+output_tokens;

CREATE TABLE shared_delegations (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES shared_sessions(id),
  turn_id uuid NOT NULL REFERENCES shared_turns(id),
  job_id uuid NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  operation_key text NOT NULL,
  arguments_hash text NOT NULL,
  reserved_tokens integer NOT NULL CHECK (reserved_tokens > 0),
  charged_tokens bigint NOT NULL DEFAULT 0 CHECK (charged_tokens >= 0),
  settled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(session_id,operation_key)
);

CREATE TABLE delegation_inputs (
  delegation_id uuid NOT NULL REFERENCES shared_delegations(id) ON DELETE CASCADE,
  path text NOT NULL,
  sha256 text NOT NULL,
  content bytea NOT NULL CHECK (octet_length(content)<=1048576),
  PRIMARY KEY(delegation_id,path)
);
CREATE TABLE job_artifacts (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  path text NOT NULL,
  sha256 text NOT NULL,
  content bytea NOT NULL CHECK (octet_length(content)<=1048576),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(attempt_id,path)
);

CREATE TABLE shared_completion_inbox (
  id uuid PRIMARY KEY,
  delegation_id uuid NOT NULL UNIQUE REFERENCES shared_delegations(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','delivering','delivered','needs_review','closed')),
  activation_epoch uuid,
  delivery_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivered_at timestamptz
);

CREATE TABLE execution_controller (
  id integer PRIMARY KEY CHECK (id=1),
  namespace text NOT NULL,
  owner uuid,
  lease_until timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE execution_allocations (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  principal text NOT NULL,
  namespace text NOT NULL,
  image text NOT NULL,
  settings jsonb NOT NULL,
  token_digest text NOT NULL,
  state text NOT NULL CHECK (state IN ('starting','running','retiring','retired')),
  attempt_id uuid REFERENCES attempts(id),
  container_id text,
  start_attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  startup_until timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  finished_at timestamptz,
  last_error text
);
CREATE UNIQUE INDEX execution_allocation_one_active ON execution_allocations(job_id) WHERE state<>'retired';
CREATE INDEX execution_allocation_tokens ON execution_allocations(token_digest);

CREATE TABLE job_inference_requests (
  request_id uuid PRIMARY KEY,
  jti uuid NOT NULL REFERENCES capabilities(jti) ON DELETE CASCADE,
  reserved_tokens integer NOT NULL DEFAULT 0 CHECK (reserved_tokens>=0),
  state text NOT NULL CHECK (state IN ('pending','completed','unknown')),
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  charged_tokens bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz
);
CREATE UNIQUE INDEX job_inference_one_pending ON job_inference_requests(jti) WHERE state='pending';
