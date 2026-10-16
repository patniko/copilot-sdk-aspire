-- One-way promotion of a shared conversation into a dedicated session container (docs/HOSTING-MODES-PLAN.md, 7.3).

-- Providers that fold key case (Windows conventions) keep each entry's name as first created, so listings and
-- promotion snapshots return it. NULL means the key's own last component is the name.
ALTER TABLE session_files ADD COLUMN display_name text
  CONSTRAINT session_file_display_name CHECK (display_name IS NULL OR (display_name <> '' AND strpos(display_name, '/') = 0));

-- No route demotes a session: once it leaves shared placement it never returns, and its generation only grows.
CREATE FUNCTION shared_sessions_one_way_placement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.placement_generation < OLD.placement_generation THEN
    RAISE EXCEPTION 'A session placement generation cannot decrease.' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.placement <> 'shared' AND NEW.placement = 'shared' THEN
    RAISE EXCEPTION 'A session cannot return to shared placement.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shared_sessions_one_way_placement BEFORE UPDATE OF placement, placement_generation ON shared_sessions
  FOR EACH ROW EXECUTE FUNCTION shared_sessions_one_way_placement();

-- Promotion requests. Each is idempotent per request key (a tool call or an API request), at most one is open per
-- session, and at most one ever commits. `failed` is terminal and leaves the session shared.
CREATE TABLE session_promotions (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES shared_sessions(id) ON DELETE CASCADE,
  principal text NOT NULL,
  source text NOT NULL CONSTRAINT session_promotion_source CHECK (source IN ('tool','api')),
  request_key text NOT NULL CONSTRAINT session_promotion_request_key CHECK (length(request_key) BETWEEN 1 AND 200),
  reason text NOT NULL DEFAULT '' CONSTRAINT session_promotion_reason CHECK (length(reason) <= 500),
  state text NOT NULL CONSTRAINT session_promotion_state CHECK (state IN ('requested','moving','starting','committed','failed')),
  size text NOT NULL,
  resources jsonb NOT NULL,
  from_generation integer NOT NULL CHECK (from_generation > 0),
  -- The storage lease epoch the snapshot was read under; the cutover commit requires it to be current.
  snapshot_epoch uuid,
  snapshot_digest text CONSTRAINT session_promotion_snapshot_digest CHECK (snapshot_digest IS NULL OR snapshot_digest ~ '^sha256:[a-f0-9]{64}$'),
  -- The workspace path the conversation's history names (the shared worker's anchor, original spelling), so the
  -- container can map it to its own.
  previous_workspace text CONSTRAINT session_promotion_previous_workspace CHECK (previous_workspace IS NULL OR length(previous_workspace) BETWEEN 1 AND 4096),
  allocation_id uuid REFERENCES execution_allocations(id) ON DELETE SET NULL,
  error_code text,
  error_message text CONSTRAINT session_promotion_error_message CHECK (error_message IS NULL OR length(error_message) <= 500),
  -- Set once the moved conversation was told about the move or the failure.
  notified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  committed_at timestamptz,
  failed_at timestamptz,
  UNIQUE (session_id, request_key),
  CONSTRAINT session_promotion_outcome CHECK (
    (state = 'committed') = (committed_at IS NOT NULL) AND (state = 'failed') = (failed_at IS NOT NULL)
    AND (state <> 'failed' OR error_code IS NOT NULL)
    AND (state NOT IN ('starting','committed') OR (snapshot_epoch IS NOT NULL AND snapshot_digest IS NOT NULL)))
);
CREATE UNIQUE INDEX session_promotion_one_open ON session_promotions(session_id) WHERE state NOT IN ('committed','failed');
CREATE UNIQUE INDEX session_promotion_one_committed ON session_promotions(session_id) WHERE state = 'committed';
CREATE INDEX session_promotion_allocation ON session_promotions(allocation_id) WHERE allocation_id IS NOT NULL;

-- The snapshot a promotion moves: runtime history and workspace files read under a fenced storage lease. The manifest
-- lists every entry in order with its digest; file contents are stored by ordinal.
CREATE TABLE session_promotion_snapshots (
  promotion_id uuid PRIMARY KEY REFERENCES session_promotions(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES shared_sessions(id) ON DELETE CASCADE,
  digest text NOT NULL CONSTRAINT session_promotion_snapshot_manifest_digest CHECK (digest ~ '^sha256:[a-f0-9]{64}$'),
  manifest jsonb NOT NULL,
  bytes bigint NOT NULL CHECK (bytes >= 0),
  entries integer NOT NULL CHECK (entries >= 0),
  epoch uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE session_promotion_snapshot_files (
  promotion_id uuid NOT NULL REFERENCES session_promotion_snapshots(promotion_id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  content bytea NOT NULL,
  PRIMARY KEY (promotion_id, ordinal)
);

-- An application session is a sequence of segments: one harness snapshot at one placement each. The first segment
-- of every session is implicit (generation 1, from the session row); promotion and handoff record the segments they
-- start.
CREATE TABLE session_segments (
  session_id uuid NOT NULL REFERENCES shared_sessions(id) ON DELETE CASCADE,
  generation integer NOT NULL CHECK (generation > 1),
  placement text NOT NULL,
  reason text NOT NULL CONSTRAINT session_segment_reason CHECK (reason IN ('promotion','handoff')),
  harness jsonb,
  ahp_session_id text NOT NULL CHECK (length(ahp_session_id) BETWEEN 1 AND 128),
  promotion_id uuid UNIQUE REFERENCES session_promotions(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (session_id, generation)
);
