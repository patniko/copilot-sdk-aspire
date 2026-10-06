CREATE TABLE demo_host (
  id integer PRIMARY KEY CHECK (id = 1),
  compute_id uuid NOT NULL,
  owner text NOT NULL,
  epoch uuid NOT NULL,
  lease_until timestamptz NOT NULL,
  environment_id text,
  server_key jsonb
);

CREATE TABLE hosted_sessions (
  id uuid PRIMARY KEY,
  owner text NOT NULL,
  harness jsonb NOT NULL,
  model text NOT NULL,
  token_budget integer NOT NULL CHECK (token_budget > 0),
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  closed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hosted_session_grants (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES hosted_sessions(id),
  epoch uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  UNIQUE (session_id, epoch)
);

CREATE TABLE hosted_usage_reports (
  id uuid PRIMARY KEY,
  grant_id uuid NOT NULL REFERENCES hosted_session_grants(id),
  input_tokens integer NOT NULL CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL CHECK (output_tokens >= 0)
);
