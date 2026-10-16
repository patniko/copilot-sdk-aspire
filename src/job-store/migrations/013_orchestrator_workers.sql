-- Orchestrator workers (docs/HOSTING-MODES-PLAN.md, section 7.4): child application sessions that a mode-4
-- coordinator session starts, messages, interrupts, and archives. A worker's id is its own application and runtime
-- session ID; workers have no shared_sessions row of their own. Each worker runs in one session-container allocation
-- (purpose 'worker') requested in the same transaction that admits it, and holds capacity until that allocation is
-- retired (released_at), so starting, running, and stopping workers all count.
CREATE TABLE session_workers (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES shared_sessions(id) ON DELETE CASCADE,
  principal text NOT NULL,
  name text NOT NULL,
  source text NOT NULL CHECK (source IN ('listed','crafted')),
  harness_name text NOT NULL,
  harness_version text NOT NULL,
  harness_digest text NOT NULL,
  -- The admitted (listed) or crafted harness definition. Crafted definitions are recorded, never published.
  definition jsonb NOT NULL,
  template text,
  policy_digest text,
  -- The coordinator tool call that created the worker, and its canonical arguments, for idempotency.
  operation_key text NOT NULL,
  arguments_hash text NOT NULL,
  turn_id uuid REFERENCES shared_turns(id) ON DELETE SET NULL,
  size text NOT NULL,
  resources jsonb NOT NULL,
  shared_volume text NOT NULL CHECK (shared_volume IN ('none','read-write','read-only')),
  approval_mode text NOT NULL CHECK (approval_mode IN ('manual','assisted','allow-all','custom')),
  inherit_authority boolean NOT NULL DEFAULT false,
  coordinator_answers boolean NOT NULL DEFAULT false,
  model text NOT NULL,
  max_turn_seconds integer NOT NULL CHECK (max_turn_seconds > 0),
  idle_seconds integer NOT NULL CHECK (idle_seconds > 0),
  input_timeout_seconds integer NOT NULL CHECK (input_timeout_seconds BETWEEN 30 AND 3600),
  state text NOT NULL DEFAULT 'starting' CHECK (state IN ('starting','working','idle','needs_input','stopped')),
  stop_reason text CHECK (stop_reason IN ('archived','idle_timeout','max_lifetime','budget_exhausted','coordinator_closed','failed')),
  -- The runtime turn in progress, reported by the worker's container; requests for a person belong to it.
  current_turn text,
  interrupt_requested_at timestamptz,
  result text CHECK (char_length(result) <= 16000),
  result_truncated boolean NOT NULL DEFAULT false,
  result_at timestamptz,
  last_error text,
  -- The worker's reservation from the coordinator's aggregate budget, settled once its allocation is retired.
  token_budget integer NOT NULL CHECK (token_budget > 0),
  tokens_used bigint NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
  charged_tokens bigint NOT NULL DEFAULT 0 CHECK (charged_tokens >= 0),
  settled boolean NOT NULL DEFAULT false,
  turns integer NOT NULL DEFAULT 0 CHECK (turns >= 0),
  -- Set in the admitting transaction, right after the allocation is requested.
  allocation_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_activity_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  idle_since timestamptz,
  expires_at timestamptz NOT NULL,
  stopped_at timestamptz,
  released_at timestamptz,
  UNIQUE (session_id, operation_key),
  UNIQUE (session_id, name),
  CONSTRAINT session_workers_stop CHECK ((state = 'stopped') = (stop_reason IS NOT NULL AND stopped_at IS NOT NULL)),
  CONSTRAINT session_workers_release CHECK (released_at IS NULL OR state = 'stopped')
);
CREATE INDEX session_workers_by_session ON session_workers (session_id, created_at);
CREATE INDEX session_workers_holding ON session_workers (principal) WHERE released_at IS NULL;
CREATE INDEX session_workers_running ON session_workers (created_at) WHERE state <> 'stopped';

-- Worker allocations: a session-container allocation whose subject is a worker instead of an application session.
-- The coordinator session is reached through the worker. Worker-private volumes are owned by the worker's id.
ALTER TABLE execution_allocations DROP CONSTRAINT execution_allocation_purpose;
ALTER TABLE execution_allocations ADD CONSTRAINT execution_allocation_purpose CHECK (purpose IN ('session','worker'));
ALTER TABLE execution_allocations ADD COLUMN worker_id uuid REFERENCES session_workers(id) ON DELETE CASCADE;
ALTER TABLE execution_allocations DROP CONSTRAINT execution_allocation_binding;
ALTER TABLE execution_allocations ADD CONSTRAINT execution_allocation_binding CHECK (
  (kind='job' AND job_id IS NOT NULL AND session_id IS NULL AND worker_id IS NULL AND namespace IS NOT NULL
    AND image IS NOT NULL AND settings IS NOT NULL AND token_digest IS NOT NULL)
  OR (kind='session' AND job_id IS NULL
    AND ((purpose='session' AND session_id IS NOT NULL AND worker_id IS NULL)
      OR (purpose='worker' AND worker_id IS NOT NULL AND session_id IS NULL))
    AND size IS NOT NULL AND resources IS NOT NULL AND idle_seconds IS NOT NULL
    AND ((image IS NULL AND settings IS NULL AND token_digest IS NULL AND ingress_credential IS NULL)
      OR (namespace IS NOT NULL AND image IS NOT NULL AND settings IS NOT NULL AND token_digest IS NOT NULL
        AND ingress_credential IS NOT NULL))));
CREATE UNIQUE INDEX execution_allocation_one_worker ON execution_allocations(worker_id) WHERE state<>'retired';
ALTER TABLE session_workers ADD CONSTRAINT session_workers_allocation FOREIGN KEY (allocation_id) REFERENCES execution_allocations(id);
ALTER TABLE execution_volumes DROP CONSTRAINT execution_volume_purpose;
ALTER TABLE execution_volumes ADD CONSTRAINT execution_volume_purpose CHECK (purpose IN ('session','shared','worker'));

-- Turns a worker's container reported, so a repeated report changes nothing.
CREATE TABLE worker_turns (
  worker_id uuid NOT NULL REFERENCES session_workers(id) ON DELETE CASCADE,
  turn_id text NOT NULL CHECK (char_length(turn_id) BETWEEN 1 AND 128),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  interrupted boolean,
  PRIMARY KEY (worker_id, turn_id)
);

-- Durable coordinator-to-worker messages, delivered in sequence. The first task is message 1.
CREATE TABLE worker_messages (
  id uuid PRIMARY KEY,
  worker_id uuid NOT NULL REFERENCES session_workers(id) ON DELETE CASCADE,
  seq integer NOT NULL CHECK (seq > 0),
  operation_key text NOT NULL,
  arguments_hash text NOT NULL,
  delivery text NOT NULL CHECK (delivery IN ('immediate','enqueue')),
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 16000),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','delivered','cancelled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivered_at timestamptz,
  UNIQUE (worker_id, seq),
  UNIQUE (worker_id, operation_key)
);
CREATE INDEX worker_messages_pending ON worker_messages (worker_id, seq) WHERE state = 'pending';

-- The coordinator's durable inbox: worker events delivered as bounded continuations, never polled inside a turn.
-- A batch keeps its members across delivery retries so the runtime-history marker identifies it.
CREATE TABLE worker_inbox (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES shared_sessions(id) ON DELETE CASCADE,
  worker_id uuid NOT NULL REFERENCES session_workers(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('completed','idle','needs_input','failed','stopped')),
  detail jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','delivering','delivered','needs_review','closed')),
  batch_id uuid,
  activation_epoch uuid,
  delivery_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivered_at timestamptz
);
CREATE INDEX worker_inbox_open ON worker_inbox (session_id, created_at) WHERE state IN ('pending','delivering');
CREATE INDEX worker_inbox_batch ON worker_inbox (batch_id) WHERE batch_id IS NOT NULL;

-- Worker approvals and questions for a person, each bound to the turn that raised it. The coordinator may answer
-- questions only, and only when the policy recorded on the worker allows it; it never decides a permission request.
CREATE TABLE worker_input_requests (
  id uuid PRIMARY KEY,
  worker_id uuid NOT NULL REFERENCES session_workers(id) ON DELETE CASCADE,
  turn_id text NOT NULL,
  runtime_request_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('permission','question')),
  request jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','answered','expired','cancelled')),
  response jsonb,
  answered_by text,
  answered_as text CHECK (answered_as IN ('principal','coordinator')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  resolved_at timestamptz,
  UNIQUE (worker_id, runtime_request_id),
  CONSTRAINT worker_input_coordinator_questions CHECK (answered_as IS DISTINCT FROM 'coordinator' OR kind = 'question')
);
CREATE INDEX worker_input_pending ON worker_input_requests (worker_id, created_at) WHERE state = 'pending';

-- Renewable inference grants for a worker's allocation, charged to the worker's reservation.
CREATE TABLE worker_grants (
  id uuid PRIMARY KEY,
  worker_id uuid NOT NULL REFERENCES session_workers(id) ON DELETE CASCADE,
  allocation_id uuid NOT NULL UNIQUE REFERENCES execution_allocations(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE TABLE worker_usage (
  request_id uuid PRIMARY KEY,
  grant_id uuid NOT NULL REFERENCES worker_grants(id) ON DELETE CASCADE,
  tokens bigint NOT NULL CHECK (tokens >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Inherited human authority: the coordinator session's human messages, read by the coordinator's host from its own
-- runtime history and recorded here before a worker's container receives them. The container reports what the
-- runtime accepted; it never supplies messages.
CREATE TABLE worker_authority_grants (
  id uuid PRIMARY KEY,
  worker_id uuid NOT NULL REFERENCES session_workers(id) ON DELETE CASCADE,
  source_session_id uuid NOT NULL,
  messages jsonb NOT NULL,
  digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  applied_at timestamptz,
  message_count integer CHECK (message_count >= 0),
  over_limit_count integer CHECK (over_limit_count >= 0)
);
CREATE INDEX worker_authority_by_worker ON worker_authority_grants (worker_id, created_at);
