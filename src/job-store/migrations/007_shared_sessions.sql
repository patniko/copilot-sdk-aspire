CREATE TABLE shared_sessions (
  id uuid PRIMARY KEY,
  principal text NOT NULL,
  github_user_id bigint NOT NULL CHECK (github_user_id > 0),
  label text NOT NULL,
  definition jsonb NOT NULL,
  closed boolean NOT NULL DEFAULT false,
  cancel_children boolean NOT NULL DEFAULT false,
  tokens_used bigint NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
  tokens_reserved bigint NOT NULL DEFAULT 0 CHECK (tokens_reserved >= 0),
  jobs integer NOT NULL DEFAULT 0 CHECK (jobs >= 0),
  continuations integer NOT NULL DEFAULT 0 CHECK (continuations >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_activity_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX shared_sessions_principal ON shared_sessions(principal, created_at DESC);

CREATE TABLE shared_activations (
  session_id uuid PRIMARY KEY REFERENCES shared_sessions(id) ON DELETE CASCADE,
  epoch uuid NOT NULL,
  server_key jsonb NOT NULL,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE shared_connection_tickets (
  digest text PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES shared_sessions(id) ON DELETE CASCADE,
  principal text NOT NULL,
  epoch uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE TABLE shared_turns (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES shared_sessions(id) ON DELETE CASCADE,
  principal text NOT NULL,
  epoch uuid NOT NULL,
  operation_key text NOT NULL,
  source text NOT NULL CHECK (source IN ('user','completion')),
  state text NOT NULL CHECK (state IN ('queued','running','finished','interrupted')),
  token_budget integer NOT NULL DEFAULT 0 CHECK (token_budget >= 0),
  tokens_used bigint NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
  settled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  deadline timestamptz,
  finished_at timestamptz,
  UNIQUE(session_id, operation_key)
);
CREATE UNIQUE INDEX shared_turn_one_active ON shared_turns(session_id) WHERE state IN ('queued','running');
CREATE INDEX shared_turn_queue ON shared_turns(created_at, id) WHERE state='queued';

CREATE TABLE shared_inference_requests (
  request_id uuid PRIMARY KEY,
  turn_id uuid NOT NULL REFERENCES shared_turns(id) ON DELETE CASCADE,
  reserved_tokens integer NOT NULL CHECK (reserved_tokens > 0),
  state text NOT NULL CHECK (state IN ('pending','completed','unknown')),
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  charged_tokens bigint NOT NULL DEFAULT 0 CHECK (charged_tokens >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz
);
CREATE UNIQUE INDEX shared_inference_one_pending ON shared_inference_requests(turn_id) WHERE state='pending';
