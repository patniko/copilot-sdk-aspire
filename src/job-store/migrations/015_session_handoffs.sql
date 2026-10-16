-- Handoffs: transfers of conversation control to another predefined harness (docs/HOSTING-MODES-PLAN.md, 7.5).
-- Each is recorded once per request key (the transfer tool call). `refused` and `failed` leave the source harness in
-- control; `accepted` admits no new turns until the cutover; `committed` started the target's segment. At most one
-- handoff of a session is open, and none starts while a promotion is open.
CREATE TABLE session_handoffs (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES shared_sessions(id) ON DELETE CASCADE,
  principal text NOT NULL,
  request_key text NOT NULL CONSTRAINT session_handoff_request_key CHECK (length(request_key) BETWEEN 1 AND 200),
  state text NOT NULL CONSTRAINT session_handoff_state CHECK (state IN ('refused','accepted','committed','failed')),
  from_generation integer NOT NULL CONSTRAINT session_handoff_from_generation CHECK (from_generation > 0),
  from_placement text NOT NULL CONSTRAINT session_handoff_from_placement CHECK (from_placement IN ('shared','container')),
  -- The source segment's harness reference, and the target as resolved when the handoff was checked.
  source jsonb NOT NULL,
  target_name text NOT NULL,
  target jsonb,
  to_placement text CONSTRAINT session_handoff_to_placement CHECK (to_placement IS NULL OR to_placement IN ('shared','container')),
  history text NOT NULL CONSTRAINT session_handoff_history CHECK (history IN ('full','summary','none')),
  approval text NOT NULL CONSTRAINT session_handoff_approval CHECK (approval IN ('ask','allow')),
  approved_by text CONSTRAINT session_handoff_approved_by CHECK (approved_by IS NULL OR approved_by IN ('person','policy')),
  -- The validated payload the source passed: a reason and, for summary history, a bounded summary.
  payload jsonb NOT NULL,
  to_generation integer CONSTRAINT session_handoff_to_generation CHECK (to_generation IS NULL OR to_generation > 1),
  ahp_session_id text CONSTRAINT session_handoff_ahp_session CHECK (ahp_session_id IS NULL OR length(ahp_session_id) BETWEEN 1 AND 128),
  error_code text,
  error_message text CONSTRAINT session_handoff_error_message CHECK (error_message IS NULL OR length(error_message) <= 500),
  error_prerequisite jsonb,
  -- A move into the target's container runs as a promotion of kind 'handoff'; that promotion's outcome settles this handoff.
  promotion_id uuid UNIQUE REFERENCES session_promotions(id) ON DELETE SET NULL,
  -- Set once the target was told about the handoff in its first turn.
  notified_at timestamptz,
  -- Set once the target's first activation prepared the session's storage: a fresh runtime session moves the source's
  -- runtime state aside, and full history drops the source's session-scoped consent.
  storage_prepared_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  committed_at timestamptz,
  failed_at timestamptz,
  UNIQUE (session_id, request_key),
  CONSTRAINT session_handoff_outcome CHECK (
    (state = 'committed') = (committed_at IS NOT NULL) AND (state IN ('refused','failed')) = (failed_at IS NOT NULL)
    AND (state NOT IN ('refused','failed') OR error_code IS NOT NULL)
    AND (state NOT IN ('accepted','committed') OR (target IS NOT NULL AND to_placement IS NOT NULL AND approved_by IS NOT NULL))
    AND (state <> 'committed' OR (to_generation IS NOT NULL AND ahp_session_id IS NOT NULL))
    AND (promotion_id IS NULL OR to_placement = 'container'))
);
CREATE UNIQUE INDEX session_handoff_one_open ON session_handoffs(session_id) WHERE state = 'accepted';
CREATE INDEX session_handoff_session ON session_handoffs(session_id, created_at);

-- The segment a committed handoff started.
ALTER TABLE session_segments ADD COLUMN handoff_id uuid UNIQUE REFERENCES session_handoffs(id) ON DELETE SET NULL;

-- A handoff notice starts the target's first turn. It is neither a person's message nor a job continuation.
ALTER TABLE shared_turns DROP CONSTRAINT shared_turns_source_check;
ALTER TABLE shared_turns ADD CONSTRAINT shared_turns_source_check CHECK (source IN ('user','completion','handoff'));
