-- Resumable session containers. A session whose hosting mode is `isolated` runs its loop in a dedicated container
-- with a retained volume. The placement `container` routes brokered connections to that container.
ALTER TABLE shared_sessions DROP CONSTRAINT shared_sessions_placement_kind;
ALTER TABLE shared_sessions ADD CONSTRAINT shared_sessions_placement_kind CHECK (placement IN ('shared','container'));

-- The container placement of a session. The session's `definition` carries its harness reference, hosting mode, model
-- and limits (including the idle stop and turn deadline); this table keeps the admitted harness snapshot the
-- container runs and the size it was admitted with.
CREATE TABLE session_containers (
  session_id uuid PRIMARY KEY REFERENCES shared_sessions(id) ON DELETE CASCADE,
  harness jsonb NOT NULL,
  size text NOT NULL,
  resources jsonb NOT NULL,
  activations integer NOT NULL DEFAULT 0 CHECK (activations >= 0)
);

-- Volumes the controller creates for allocations. One `session` volume per session; `shared` is reserved for
-- per-session volumes that several worker containers mount. Volumes are retained data: closing a session only
-- releases its volume (no further mounts), and nothing here is deleted automatically.
CREATE TABLE execution_volumes (
  name text PRIMARY KEY,
  namespace text NOT NULL,
  session_id uuid NOT NULL,
  purpose text NOT NULL CONSTRAINT execution_volume_purpose CHECK (purpose IN ('session','shared')),
  principal text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  observed_at timestamptz,
  released_at timestamptz,
  UNIQUE (namespace, session_id, purpose)
);

-- Allocations are either one-shot jobs or resumable session allocations. A session allocation is requested unbound;
-- the controller binds the image, settings, credential digest and volumes before it creates the container.
ALTER TABLE execution_allocations
  ADD COLUMN kind text NOT NULL DEFAULT 'job' CONSTRAINT execution_allocation_kind CHECK (kind IN ('job','session')),
  ADD COLUMN session_id uuid REFERENCES shared_sessions(id) ON DELETE CASCADE,
  ADD COLUMN purpose text CONSTRAINT execution_allocation_purpose CHECK (purpose IN ('session')),
  ADD COLUMN size text,
  ADD COLUMN resources jsonb,
  ADD COLUMN volumes jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN idle_seconds integer CHECK (idle_seconds > 0),
  ADD COLUMN ingress jsonb,
  ADD COLUMN ingress_credential text,
  ADD COLUMN server_key jsonb,
  ADD COLUMN ready_at timestamptz,
  ADD COLUMN heartbeat_at timestamptz,
  ADD COLUMN activity_at timestamptz,
  ALTER COLUMN job_id DROP NOT NULL,
  ALTER COLUMN namespace DROP NOT NULL,
  ALTER COLUMN image DROP NOT NULL,
  ALTER COLUMN settings DROP NOT NULL,
  ALTER COLUMN token_digest DROP NOT NULL,
  ADD CONSTRAINT execution_allocation_binding CHECK (
    (kind='job' AND job_id IS NOT NULL AND session_id IS NULL AND namespace IS NOT NULL AND image IS NOT NULL
      AND settings IS NOT NULL AND token_digest IS NOT NULL)
    OR (kind='session' AND job_id IS NULL AND session_id IS NOT NULL AND purpose IS NOT NULL AND size IS NOT NULL
      AND resources IS NOT NULL AND idle_seconds IS NOT NULL
      AND ((image IS NULL AND settings IS NULL AND token_digest IS NULL AND ingress_credential IS NULL)
        OR (namespace IS NOT NULL AND image IS NOT NULL AND settings IS NOT NULL AND token_digest IS NOT NULL
          AND ingress_credential IS NOT NULL))));
CREATE UNIQUE INDEX execution_allocation_one_session ON execution_allocations(session_id) WHERE state<>'retired';

-- Renewable inference grants for a session container, fenced by its allocation.
CREATE TABLE session_container_grants (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES shared_sessions(id) ON DELETE CASCADE,
  allocation_id uuid NOT NULL UNIQUE REFERENCES execution_allocations(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE TABLE session_container_usage (
  request_id uuid PRIMARY KEY,
  grant_id uuid NOT NULL REFERENCES session_container_grants(id) ON DELETE CASCADE,
  input_tokens bigint NOT NULL CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL CHECK (output_tokens >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
