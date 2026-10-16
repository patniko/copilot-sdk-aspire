-- Orchestrator workers (docs/HOSTING-MODES-PLAN.md, section 7.4): child application sessions that a mode-4
-- coordinator session starts, messages, interrupts, and archives. A worker's id is its own application and runtime
-- session ID; workers have no shared_sessions row of their own. A worker holds capacity from admission until its
-- container is confirmed released (released_at), so starting, running, and stopping workers all count.
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
  state text NOT NULL DEFAULT 'starting' CHECK (state IN ('starting','working','idle','needs_input','stopped')),
  stop_reason text CHECK (stop_reason IN ('archived','idle_timeout','max_lifetime','budget_exhausted','coordinator_closed','failed')),
  interrupt_requested_at timestamptz,
  result text CHECK (char_length(result) <= 16000),
  result_truncated boolean NOT NULL DEFAULT false,
  result_at timestamptz,
  last_error text,
  -- The worker's reservation from the coordinator's aggregate budget, settled once its container is released.
  token_budget integer NOT NULL CHECK (token_budget > 0),
  tokens_used bigint NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
  charged_tokens bigint NOT NULL DEFAULT 0 CHECK (charged_tokens >= 0),
  settled boolean NOT NULL DEFAULT false,
  turns integer NOT NULL DEFAULT 0 CHECK (turns >= 0),
  -- Container time for cost attribution: completed runs plus the current run since container_started_at.
  container_ms bigint NOT NULL DEFAULT 0 CHECK (container_ms >= 0),
  container_started_at timestamptz,
  -- The session-container allocation, once one exists. No foreign key until that ledger lands.
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

-- Worker approvals and questions for a person. The coordinator may answer questions only, and only when the
-- policy recorded on the worker allows it; it never decides a permission request.
CREATE TABLE worker_input_requests (
  id uuid PRIMARY KEY,
  worker_id uuid NOT NULL REFERENCES session_workers(id) ON DELETE CASCADE,
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

-- Human messages the platform supplied to an assisted worker's judge as inherited authority, kept for audit.
CREATE TABLE worker_authority_grants (
  id uuid PRIMARY KEY,
  worker_id uuid NOT NULL REFERENCES session_workers(id) ON DELETE CASCADE,
  source_session_id uuid NOT NULL,
  messages jsonb NOT NULL,
  message_count integer NOT NULL CHECK (message_count >= 0),
  over_limit_count integer NOT NULL DEFAULT 0 CHECK (over_limit_count >= 0),
  digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX worker_authority_by_worker ON worker_authority_grants (worker_id, created_at);
