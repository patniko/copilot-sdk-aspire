-- Per-harness owner hosts replace the deployment-wide demo_host singleton. A host is keyed by its harness and
-- bound to one owner: every lease, session, grant, and ticket operation checks both. Changing a harness host's
-- owner is not an in-place reassignment; a different numeric GitHub account cannot acquire the existing host.
CREATE TABLE owner_hosts (
  harness text PRIMARY KEY CHECK (harness ~ '^[a-z][a-z0-9-]{1,62}$'),
  owner text NOT NULL,
  -- 0 marks an adopted legacy prototype host without a pinned identity; it can never be acquired.
  owner_user_id bigint NOT NULL CHECK (owner_user_id >= 0),
  compute_id uuid NOT NULL,
  epoch uuid NOT NULL,
  lease_until timestamptz NOT NULL,
  execution text NOT NULL CHECK (execution IN ('managed', 'github-native')),
  environment_id text,
  server_key jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The existing singleton row stays in demo_host until a dispatcher or API configured with the legacy
-- demo-host-* parameters adopts it as the host for its configured harness (HostStore.adoptLegacyHost):
-- the migration cannot know that harness. Sessions of an unadopted legacy host keep a NULL host_harness.
ALTER TABLE hosted_sessions ADD COLUMN host_harness text;
CREATE INDEX hosted_sessions_by_host ON hosted_sessions (host_harness, owner, created_at DESC);
-- A host mints the runtime session ID (the canonical UUID in id, which grants carry) separately from the
-- client-visible AHP session ID that clients resume; the host records the latter once it appears in its catalog.
ALTER TABLE hosted_sessions ADD COLUMN ahp_session_id text CHECK (ahp_session_id ~ '^[A-Za-z0-9_-]{1,128}$');
CREATE UNIQUE INDEX hosted_sessions_by_ahp_identity ON hosted_sessions (host_harness, ahp_session_id) WHERE ahp_session_id IS NOT NULL;

-- Connection tickets live for 60 seconds; outstanding ones are discarded rather than guessed onto a harness.
DELETE FROM hosted_connection_tickets;
ALTER TABLE hosted_connection_tickets ADD COLUMN harness text NOT NULL;